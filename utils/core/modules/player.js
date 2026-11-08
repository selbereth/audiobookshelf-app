/**
 * Player control decisions (Phase 9, slice 1: the auto-rewind after a pause). Ported from
 * android/app/src/main/java/com/audiobookshelf/app/player/PlayerListener.kt. Every rule names its Kotlin source
 * (file:line, on master 96f28d39). Nothing here plays, pauses or seeks: native does the call on the player.
 *
 * It runs only while the switch `system.flags` {corePlayer} is on (start() reads it, default off). While it is off,
 * PlayerListener's own auto-rewind runs, as before. While it is on, PlayerListener does not seek back (no double seek).
 *
 * Connectors used:
 *   player.getState     {live, positionSec, session}      (on the playing event: the chapter at the position)
 *   player.seekBackward {ms}                              (the seek; native clamps it as before)
 *   system.flags        (the switch)
 *   db.methods.getDeviceData (deviceSettings.disableAutoRewind)
 * Events in: player/state {reason, atMs, sessionId, positionSec}: paused sets the pause time, seeked clears it, playing
 * seeks back. The times are the native clock at the moment of the change (atMs), so the core's latency does not count.
 *
 * Kept native (see the vault questions): the buffering and lazy-play filters that decide which events exist.
 */
import { chapterAt, chapterStartMs } from './sleep'

const msOf = (sec) => Math.round(sec * 1000) // PlayerNotificationService.kt:806-808 getCurrentTime (ms)

/**
 * PlayerListener.kt:166-174 calcPauseSeekBackTime: how far back to jump after a pause of this length.
 * `pausedAtMs` 0 (or below) means there was no pause to measure (the Kotlin check `lastPauseTime <= 0`).
 */
export function pauseSeekBackMs(pausedAtMs, nowMs) {
  if (pausedAtMs <= 0) return 0 // :167
  const time = nowMs - pausedAtMs // :168
  if (time < 10000) return 0 // :170 10 s or less: no seek back
  if (time < 60000) return 3000 // :171 10 s to 1 m
  if (time < 300000) return 10000 // :172 1 m to 5 m
  if (time < 1800000) return 20000 // :173 5 m to 30 m
  return 29500 // :174 30 m and up
}

/**
 * PlayerListener.kt:66-94 (the playing branch): the seek back after a pause, clamped so it does not go back past the
 * start of the current chapter (:70-77, "so that seek back does not go back to the previous chapter").
 * Returns the amount in ms; 0 means no seek. The caller seeks only when it is above 0 (:90).
 */
export function pauseSeekAmountMs({ pausedAtMs, nowMs, disableAutoRewind, positionMs, chapter }) {
  if (!(pausedAtMs > 0)) return 0 // :66 lastPauseTime > 0
  if (disableAutoRewind === true) return 0 // :66 disableAutoRewind != true
  let seekBack = pauseSeekBackMs(pausedAtMs, nowMs) // :68
  if (seekBack > 0) {
    const minSeekBack = chapter ? chapterStartMs(chapter) : 0 // :72 currentChapter?.startMs ?: 0
    const newTime = positionMs - seekBack // :75
    if (newTime < minSeekBack) seekBack = positionMs - minSeekBack // :76-77
  }
  return seekBack
}

export function playerModule(bridge, { db, now = () => Date.now(), log = () => {} } = {}) {
  let pausedAt = 0 // PlayerListener.lastPauseTime (ms, native clock); 0 = no pause to measure
  let gate = Promise.resolve(false) // the switch, read once by start()
  let queue = Promise.resolve() // one rule at a time, like Kotlin's main thread

  const later = (fn) => {
    const p = queue.then(() => gate).then((on) => (on ? fn() : null))
    queue = p.then(() => {}, (e) => log('player: ' + (e && e.message)))
  }
  const native = (connector, method, args = {}) =>
    bridge.call(connector, method, args).catch((e) => {
      log(`player: ${connector}.${method} failed: ${e && e.message}`)
      return undefined
    })

  /** PlayerListener.kt:66-94 */
  async function onPlaying(atMs) {
    if (!(pausedAt > 0)) return // :66
    const settings = ((await db.methods.getDeviceData()) || {}).deviceSettings || {}
    const st = await native('player', 'getState')
    if (!st || !st.live) return // no player: nothing to seek
    const positionMs = msOf(st.positionSec) // :74 getCurrentTime
    const chapter = st.session ? chapterAt(st.session, positionMs) : null // :71 getCurrentBookChapter
    const amount = pauseSeekAmountMs({
      pausedAtMs: pausedAt,
      nowMs: atMs,
      disableAutoRewind: settings.disableAutoRewind,
      positionMs,
      chapter
    })
    if (amount > 0) await native('player', 'seekBackward', { ms: amount }) // :90-91
  }

  /** player/state from PlayerConnector.emitState (the same events PlayerListener handles) */
  async function onPlayerState(d) {
    const atMs = typeof d.atMs === 'number' ? d.atMs : now()
    if (d.reason === 'paused') pausedAt = atMs // :96 lastPauseTime = System.currentTimeMillis()
    else if (d.reason === 'seeked') pausedAt = 0 // :36 lastPauseTime = 0 on a seek
    else if (d.reason === 'playing') await onPlaying(atMs) // :66-94
  }

  function start() {
    gate = bridge
      .call('system', 'flags', {})
      .then(
        (f) => f?.corePlayer === true,
        (e) => {
          log('player: the switch could not be read, the core auto-rewind stays off: ' + (e && e.message))
          return false
        }
      )
    bridge.on('player', 'state', (d) => later(() => onPlayerState(d)))
  }

  return {
    start,
    /** For tests: the pause time the rule holds */
    pausedAt: () => pausedAt,
    /** For tests: the play rule without an event */
    handlePlayerState: (d) => { later(() => onPlayerState(d)); return queue }
  }
}
