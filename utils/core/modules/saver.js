/**
 * Progress saving decisions (Phase 4b-2; design note audiobookshelf-core-refactor-design-progress-tick, step 5).
 * Ported from android/app/src/main/java/com/audiobookshelf/app/media/MediaProgressSyncer.kt, which still runs playback:
 * this module is NOT wired to the player yet. Each rule names its Kotlin source (file:line).
 *
 * Input: `player.state` events {reason, sessionId, playing, positionSec, error?} and `session/opened` {session}; the tick
 * (tick.js, every TICK_MS while playing); `system/network` {connected, metered}.
 * Native calls: `player.getPosition` (one tick), `player.getState` (restore after a core restart).
 * Output: db writes (playback session row, local media progress, history events), progress.* server calls, alerts.
 *
 * Differences from the Kotlin, all deliberate (see the vault questions note):
 *  - timeListening of a session counts each listened second once. Kotlin added the seconds of every tick, including the
 *    ticks that were not sent (MediaProgressSyncer.kt:238-239 with :298-321). Option `legacyTimeListening` reproduces it.
 *    The server payload is the same in both: the seconds since the last successful send.
 *  - a seek while paused starts no counting window. Kotlin's play() after a seek (PlayerListener.kt:31-34) started one,
 *    so the paused time was counted on the next tick (not run on a device; read from the code).
 *  - the clock of a successful send is the time of the tick, not the time of the response.
 *  - the open session has its own record (openSession), so a core restart keeps the counted time and the unsent seconds.
 *  - a server session with no successful send keeps its unsent seconds across a pause (Kotlin reset them).
 */
import * as rules from './dbRules'

const C = rules.COLLECTIONS

export const TICK_ID = 'progress'
export const TICK_MS = 15000 // MediaProgressSyncer.kt:79
export const METERED_SYNC_MS = 60000 // :33
export const MIN_LISTEN_MS = 1000 // :233
export const ALERT_AFTER_FAILURES = 2 // :284, :311
export const PLAYMETHOD_LOCAL = 3 // player/PlayerConstants.kt:12
export const POSITION_TIMEOUT_MS = 3000 // core choice: a silent native must not hang the saver (Kotlin has no timeout)

const NOT_ATTEMPTED = Object.freeze({ serverSyncAttempted: false, serverSyncSuccess: null, serverSyncMessage: null }) // :295, :321
const clone = (o) => JSON.parse(JSON.stringify(o))
const sessionIsLocal = (s) => s.playMethod === PLAYMETHOD_LOCAL // PlaybackSession.kt isLocal

export function saverModule(bridge, {
  progress,
  db,
  tick,
  now = () => Date.now(),
  log = () => {},
  alert = () => {}, // alert('success' | 'failing'): MediaProgressSyncer.kt:279, :285, :306, :312 (the UI shows it)
  emit = () => {}, // emit(event, data): onLocalMediaProgressUpdate (:344)
  legacyTimeListening = false,
  positionTimeoutMs = POSITION_TIMEOUT_MS
} = {}) {
  let session = null // the open session (Kotlin currentPlaybackSession)
  let running = false // Kotlin listeningTimerRunning (:36)
  let accountedT = null // time up to which listened seconds are counted into session.timeListening
  let lastSyncT = null // Kotlin lastSyncTime (:38): window start, each local save, each successful server send; null after a pause
  let unsentSec = 0 // server sessions: seconds counted since the last successful send (the payload of the next send)
  let failedSyncs = 0 // Kotlin failedSyncs (:39)
  let net = { connected: false, metered: true } // no network event yet: not connected
  let queue = Promise.resolve() // every event and tick runs here, one after the other

  const enqueue = (fn) => {
    queue = queue.then(fn).catch((e) => log('saver: ' + (e && e.message)))
    return queue
  }

  const startTimer = () =>
    tick.start(TICK_ID, { everyMs: TICK_MS, onTick: ({ t }) => enqueue(() => onTick(t)) }).then((r) => {
      if (r.error) log('saver: the tick could not be scheduled: ' + r.error)
    })
  const stopTimer = () => tick.stop(TICK_ID)

  // ---- events from native
  bridge.on('system', 'network', (d) => {
    net = { connected: d.connected === true, metered: d.metered !== false }
  })
  bridge.on('session', 'opened', (d) => enqueue(() => open(d.session)))
  bridge.on('player', 'state', (d, t) => enqueue(() => onState(d, t ?? now())))

  async function open(next) {
    if (session && session.id === next.id) return
    if (session) await db.serial(() => db.store.delete(C.openSession, session.id))
    if (running) {
      stopTimer() // Kotlin start(): a different session cancels the timer (:59)
      running = false
    }
    session = clone(next)
    accountedT = null
    lastSyncT = null
    unsentSec = 0
    failedSyncs = 0
    await persistOpen()
  }

  async function onState(d, at) {
    if (!session || (d.sessionId && d.sessionId !== session.id)) return log('saver: state for a session that is not open: ' + d.sessionId)
    switch (d.reason) {
      case 'playing':
        return playing(at)
      case 'paused':
      case 'ended': // ExoPlayer stops playing at the end: Kotlin's pause() runs first (PlayerListener.kt:41-115), then the ENDED
        return paused(d.positionSec, at) //     handler finds the timer stopped (finished(), :181-183, returns at once)
      case 'seeked':
        return seeked(d.positionSec)
      case 'closed':
        return closed(d.positionSec, d.error === true, at)
      default:
        return // 'rate': the Kotlin syncer has no decision for it (setPlaybackSpeed only saves the speed)
    }
  }

  async function playing(at) {
    await dbEvent('Play', null) // MediaProgressSyncer.kt:108-109 playEvent
    startWindow(at)
  }

  /** Kotlin start() (:53-105) for a session that is not running: the window starts now (:71) */
  function startWindow(at) {
    if (running) return // :62-64 the timer already runs for this session
    running = true
    accountedT = at
    lastSyncT = at
    startTimer()
  }

  async function paused(positionSec, at) {
    if (!running) return // :147
    stopTimer() // :149-151
    running = false
    const r = positionSec > 0 ? await sync(at, positionSec, true) : null // :156-157 (currentTime > 0), sync(true, ...)
    await dbEvent('Pause', r) // :163, :174
    lastSyncT = null // :158, :169
    accountedT = null
    failedSyncs = 0 // :160, :171
    await persistOpen()
  }

  /** Kotlin seek() (:200-210): the position is copied into the session and a Seek event is written; nothing is saved or sent */
  async function seeked(positionSec) {
    session.currentTime = positionSec // :201
    await dbEvent('Seek', null) // :209
    await persistOpen()
  }

  /** Kotlin closePlayback (:1042-1070) with stop() (:114-144): sync unless the close is after an error, then close a server session */
  async function closed(positionSec, error, at) {
    const sessionId = session.id
    const isLocal = sessionIsLocal(session)
    if (running) {
      stopTimer() // :120-122
      running = false
      const pos = error ? 0 : positionSec // :125-126: stop(calledOnError == false)
      const r = pos > 0 ? await sync(at, pos, true) : null // :127-135
      await dbEvent('Stop', r) // :130, :138
    }
    reset() // :133, :141 (also for a close while paused: stop() resets without a sync, :115-117)
    if (!isLocal && sessionId) await progress.closeSession({ playbackSessionId: sessionId }) // :1057-1066
    await db.serial(() => db.store.delete(C.openSession, sessionId))
  }

  /** Kotlin tick (:79-104): nothing unless playing (:81), syncs when the rule allows (:87-90), skips position 0 (:93) */
  async function onTick(at) {
    if (!running || !session) return
    const pos = await getPosition()
    if (!pos || !running || !session) return // a timeout keeps the window open: the next tick counts it
    if (!pos.playing) return // :81
    if (pos.sessionId && pos.sessionId !== session.id) return
    // :87-90 with lastSyncTime as it is before this tick (for a local session that is the last save, for a server one the last send)
    const shouldSync = !net.metered || at - lastSyncT >= METERED_SYNC_MS
    if (!(pos.positionSec > 0)) return // :93
    const r = await sync(at, pos.positionSec, shouldSync)
    await dbEvent('Save', r) // :94-99: every tick that reached sync() writes a Save event, with its result (null if nothing was done)
  }

  async function getPosition() {
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), positionTimeoutMs)
    })
    try {
      const r = await Promise.race([bridge.call('player', 'getPosition', {}), timeout])
      if (!r) log('saver: player.getPosition timed out')
      return r
    } catch (e) {
      log('saver: player.getPosition failed: ' + e.message)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Kotlin sync() (:226-323). Counts the listened seconds, then saves the session row and the local progress, then sends
   * (local: only linked, same server, connected, allowed; server: connected and allowed). Returns a SyncResult, or null when
   * nothing was done (:227-235, :241-247).
   */
  async function sync(at, positionSec, shouldSyncServer) {
    if (accountedT == null) return null // :227-230 last sync time is not set
    const diff = at - accountedT
    if (diff < MIN_LISTEN_MS) return null // :232-235
    const secs = Math.floor(diff / 1000) // :236
    accountedT += secs * 1000
    const s = session
    const legacy = legacyTimeListening && !sessionIsLocal(s)
    // :238-239 timeListening += listened. Legacy: the Kotlin counted from lastSyncTime, which unsent ticks do not move
    s.timeListening = (s.timeListening || 0) + (legacy ? Math.floor((at - lastSyncT) / 1000) : secs)
    if (!sessionIsLocal(s)) unsentSec += secs
    s.updatedAt = now() // :423-424 syncData
    s.currentTime = positionSec
    if (Number.isNaN(rules.sessionProgress(s))) {
      log('saver: invalid progress for session ' + s.id + ' (total duration is 0)') // :241-247
      await persistOpen()
      return null
    }
    await persistOpen()
    await db.serial(() => db.store.put(C.playbackSession, s.id, s)) // :253 saved for every session before the send
    const r = sessionIsLocal(s) ? await syncLocal(at, shouldSyncServer) : await syncServer(at, shouldSyncServer)
    await persistOpen() // after the send: the unsent seconds left are what a restart must see
    return r
  }

  /** Kotlin sync() local branch (:255-296) */
  async function syncLocal(at, shouldSyncServer) {
    const s = session
    await saveLocalProgress(s) // :258
    lastSyncT = at // :259
    const sameServer = s.serverConnectionConfigId != null && (await currentServerId()) === s.serverConnectionConfigId // :270
    if (!(net.connected && shouldSyncServer && s.libraryItemId && sameServer)) return NOT_ATTEMPTED // :271-275, :293-295
    const r = await progress.sendLocalSession({ session: s }) // :276
    if (!r.error) await removeRow(s.id) // :280
    return outcome(r)
  }

  /** Kotlin sync() server branch (:298-322). Sends what was counted since the last successful send */
  async function syncServer(at, shouldSyncServer) {
    if (!(net.connected && shouldSyncServer)) return NOT_ATTEMPTED // :298, :319-321
    const s = session
    const payload = unsentSec
    const r = await progress.sendSession({
      sessionId: s.id,
      syncData: { timeListened: payload, duration: s.duration, currentTime: s.currentTime } // MediaProgressSyncData :16-20
    })
    if (!r.error) {
      unsentSec -= payload // :305-307, the seconds the server has now
      lastSyncT = at
      await removeRow(s.id) // :308
    }
    return outcome(r)
  }

  /** The alerts and the failure count (:276-292, :301-318) */
  function outcome(r) {
    if (!r.error) {
      failedSyncs = 0 // :278, :305
      alert('success') // :279, :306
      return { serverSyncAttempted: true, serverSyncSuccess: true, serverSyncMessage: null }
    }
    failedSyncs++ // :283, :310
    if (failedSyncs === ALERT_AFTER_FAILURES) {
      alert('failing') // :285, :312
      failedSyncs = 0 // :286, :313
    }
    return { serverSyncAttempted: true, serverSyncSuccess: false, serverSyncMessage: r.error }
  }

  /** Kotlin saveLocalProgress (:325-351): an existing row takes the session (:333); a new one is created (:330) */
  async function saveLocalProgress(s) {
    const id = rules.localMediaProgressId(s.localLibraryItemId || '', s.localEpisodeId)
    await db.serial(async () => {
      const existing = await db.store.get(C.localMediaProgress, id)
      const lp = existing ? rules.applyPlaybackSession(existing, s) : rules.newLocalMediaProgressFromSession(s)
      if (Number.isNaN(lp.progress)) return log('saver: invalid progress on local media progress') // :340-341
      await db.store.put(C.localMediaProgress, id, lp)
      emit('onLocalMediaProgressUpdate', lp) // :344
    })
  }

  async function currentServerId() {
    return (await db.methods.getDeviceData()).lastServerConnectionConfigId // DeviceManager.serverConnectionConfig?.id (:270)
  }

  async function dbEvent(name, result) {
    if (!session) return
    const s = session
    await db.serial(() => db.addPlaybackEvent(name, s, result)) // MediaEventManager.addPlaybackEvent
  }

  async function removeRow(id) {
    await db.serial(() => db.store.delete(C.playbackSession, id)) // :280, :308 removePlaybackSession
  }

  async function persistOpen() {
    if (!session) return
    const s = session
    const unsent = unsentSec
    await db.serial(() => db.store.put(C.openSession, s.id, { session: s, unsentSec: unsent }))
  }

  /** Kotlin reset() (:353-359) */
  function reset() {
    session = null
    running = false
    accountedT = null
    lastSyncT = null
    unsentSec = 0
    failedSyncs = 0
  }

  /**
   * After a core restart: the native player is asked for its state and the open session is read back from the core's record.
   * Not called by the core yet (the switch-over step calls it once the Kotlin player has the connectors).
   */
  function restore() {
    return enqueue(async () => {
      if (session) return
      let st
      try {
        st = await bridge.call('player', 'getState', {})
      } catch (e) {
        return log('saver: player.getState failed: ' + e.message)
      }
      if (!st || !st.live || !st.sessionId) return
      const rec = await db.store.get(C.openSession, st.sessionId)
      if (!rec) return log('saver: no open session record for ' + st.sessionId)
      session = rec.session
      session.currentTime = st.positionSec ?? session.currentTime
      unsentSec = rec.unsentSec || 0
      if (st.playing) startWindow(now()) // the seconds while the core was down are not counted (open question)
    })
  }

  return {
    restore,
    /** Resolves when every event and tick received so far has been handled */
    idle: () => queue,
    snapshot: () => ({ sessionId: session ? session.id : null, running, unsentSec, failedSyncs })
  }
}
