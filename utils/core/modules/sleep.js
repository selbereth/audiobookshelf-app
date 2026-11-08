/**
 * The sleep timer for audio (Phase 5). Ported from android/app/src/main/java/com/audiobookshelf/app/managers/SleepTimerManager.kt.
 * Every rule names its Kotlin source (file:line). TTS keeps its own timer in TtsService for now (not part of this phase).
 *
 * It runs only while the switch `system.flags` {coreSleep} is on (start() reads it, default off). While it is off, Kotlin's
 * SleepTimerManager does everything, as before. While it is on, SleepTimerManager and AbsAudioPlayer hand every call here and
 * do nothing themselves, so only one timer ever pauses the player (no double pause).
 *
 * Native connectors used:
 *   player.getPosition  {live, playing, positionSec, rate, sessionId}   (every tick: no session JSON)
 *   player.getState     the same plus session {chapters, audioTracks, currentTime}   (user actions, the chapter timer)
 *   player.pause, player.play, player.setVolume {volume}, player.seekBackward {ms}
 *   sensor.register, sensor.unregister (immediate; the 2 minute window is the core's, see sensorOffLater)
 *   feedback.vibrate {pattern}, feedback.chime {volume}
 *   timer (through tick.js)
 * Events in: player/state {reason} (playing, paused, closed drive the 15 s auto check and the play rules), sensor/shake.
 * Calls in (native asks): sleep.set {ms, isChapterTime, sessionId}, sleep.increase {ms}, sleep.decrease {ms}, sleep.cancel,
 * sleep.resend. Events to the UI (ui.emit): sleepTimerSet {value, isAuto}, sleepTimerEnded {value: position in ms}.
 *
 * Differences from the Kotlin, kept on purpose, and listed in the vault questions note:
 *  - the 1 s tick and the 15 s auto check run on the core's own timers; the Kotlin ones are not started by the core.
 *  - a native call that fails is logged and skipped (the Kotlin would throw on the main thread).
 */

export const TICK_ID = 'sleep'
export const AUTO_ID = 'sleepAuto'
export const SENSOR_OFF_ID = 'sleepSensorOff'
export const TICK_MS = 1000 // SleepTimerManager.kt:145 schedule(0L, 1000L): one run now, then every second
export const AUTO_TICK_MS = 15000 // MediaProgressSyncer.kt:80 schedule(15000L, 15000L), the auto check runs on it (:83)
export const WAKE_UP_EXPIRATION_MS = 120000 // SLEEP_TIMER_WAKE_UP_EXPIRATION, PlayerNotificationService.kt:64 (2 min)
export const CHAPTER_MIN_LEFT_MS = 10000 // SleepTimerManager.kt:303 (less than 10 s left: use the next chapter)
export const RESET_AFTER_ELAPSED_MS = 3000 // SleepTimerManager.kt:341
export const ALMOST_DONE_SEC = 30 // SleepTimerManager.kt:164
export const FADE_SEC = 60 // SleepTimerManager.kt:177
export const FADE_FLOOR = 0.1 // SleepTimerManager.kt:184 (volume goes down to 10%)
export const CHIME_VOLUME = 0.7 // SleepTimerManager.kt:16 SLEEP_TIMER_CHIME_SOUND_VOLUME
export const VIBRATE_PATTERN = [0, 150, 150, 150] // SleepTimerManager.kt:267

const OFF = Object.freeze({ off: true })
const msOf = (sec) => Math.round(sec * 1000) // PlayerNotificationService.kt:806-808 getCurrentTime (ms)
const parseHM = (s) => String(s || '0:0').split(':').map((n) => parseInt(n, 10)) // SleepTimerManager.kt:457-461

// ---- session helpers: PlaybackSession.kt and the BookChapter / AudioTrack getters (JSON carries only the fields below)
export const chapterStartMs = (c) => Math.trunc(c.start * 1000) // DataClasses.kt:415 startMs
const chapterEndMs = (c) => Math.trunc(c.end * 1000) // DataClasses.kt:417 endMs
const trackStartMs = (t) => Math.trunc(t.startOffset * 1000) // AudioTrack.kt startOffsetMs
const trackEndMs = (t) => trackStartMs(t) + Math.trunc(t.duration * 1000) // AudioTrack.kt endOffsetMs = startOffsetMs + durationMs
const hasTracks = (s) => !!s && Array.isArray(s.audioTracks) && s.audioTracks.length > 0

/** PlaybackSession.kt:150-155 getTotalDuration, :72-73 totalDurationMs; Kotlin getDuration() is 0 with no session (:828-830) */
export function totalDurationMs(s) {
  if (!s) return 0
  let total = 0
  for (const t of s.audioTracks || []) total += t.duration
  return Math.trunc(total * 1000)
}

/** PlaybackSession.kt:88-97 getCurrentTrackIndex (uses the session's own currentTime, as Kotlin does) */
function currentTrackIndex(s) {
  const cur = Math.trunc(s.currentTime * 1000) // PlaybackSession.kt:69-70 currentTimeMs
  const tracks = s.audioTracks
  for (let i = 0; i < tracks.length; i++) {
    if (cur >= trackStartMs(tracks[i]) && trackEndMs(tracks[i]) > cur) return i
  }
  return tracks.length - 1
}

/** PlaybackSession.kt:100-108 getNextTrackIndex */
function nextTrackIndex(s) {
  const cur = Math.trunc(s.currentTime * 1000)
  const tracks = s.audioTracks
  for (let i = 0; i < tracks.length; i++) {
    if (cur < trackStartMs(tracks[i])) return i
  }
  return tracks.length - 1
}

/** PlaybackSession.kt:111-116 getChapterForTime: the chapter that contains the time */
export function chapterAt(s, ms) {
  const chapters = s.chapters || []
  if (!chapters.length) return null
  return chapters.find((c) => ms >= chapterStartMs(c) && chapterEndMs(c) > ms) || null
}

/** PlaybackSession.kt:122-127 getNextChapterForTime: the first chapter that starts after the time */
function nextChapterAt(s, ms) {
  const chapters = s.chapters || []
  if (!chapters.length) return null
  return chapters.find((c) => ms < chapterStartMs(c)) || null
}

/** PlayerNotificationService.kt:840-846 getEndTimeOfChapterOrTrack (null where Kotlin has no session; an empty track list would throw there) */
function endOfChapterOrTrack(s, ms) {
  const c = chapterAt(s, ms)
  if (c) return chapterEndMs(c)
  if (!hasTracks(s)) return null
  return trackEndMs(s.audioTracks[currentTrackIndex(s)])
}

/** PlayerNotificationService.kt:848-851 getEndTimeOfNextChapterOrTrack */
function endOfNextChapterOrTrack(s, ms) {
  const c = nextChapterAt(s, ms)
  if (c) return chapterEndMs(c)
  if (!hasTracks(s)) return null
  return trackEndMs(s.audioTracks[nextTrackIndex(s)])
}

/**
 * SleepTimerManager.kt:292-318 getChapterEndTime: the end of the current chapter or track; less than 10 s left: the next one.
 * Returns null where Kotlin logs an error and returns null (no session, no next chapter, or the next equals the current).
 */
export function chapterEndTimeFor(s, ms) {
  if (!s) return null // :294-296
  const cur = endOfChapterOrTrack(s, ms)
  if (cur == null) return null // :294-297
  if (cur - ms < CHAPTER_MIN_LEFT_MS) { // :299, :303
    const next = endOfNextChapterOrTrack(s, ms) // :305
    return next == null || cur === next ? null : next // :306-313
  }
  return cur // :316
}

/** SleepTimerManager.kt:87-94 getSleepTimerTimeRemainingSeconds. Integer division of the ms first, as Kotlin does. */
export function remainingSecOf(st, speed, curMs) {
  if (st.endMs === 0 && st.lengthMs > 0) { // :88 regular timer
    return Math.round(Math.trunc((st.lengthMs - st.elapsedMs) / 1000)) // :89
  }
  if (st.endMs <= 0) return 0 // :92
  return Math.round(Math.trunc((st.endMs - curMs) / 1000) / speed) // :93
}

export function sleepModule(bridge, { tick, db, now = () => Date.now(), log = () => {}, emitToUi = () => {} } = {}) {
  // Kotlin fields: sleepTimerRunning, sleepTimerEndTime, sleepTimerLength, sleepTimerElapsed, sleepTimerFinishedAt,
  // isAutoSleepTimer, autoTimerDisabled, sleepTimerSessionId (SleepTimerManager.kt:22-30)
  const S = { running: false, endMs: 0, lengthMs: 0, elapsedMs: 0, finishedAt: 0, isAuto: false, autoDisabled: false, sleepSessionId: '' }
  let autoSession = null // the session the 15 s auto check runs for; null = not running (MediaProgressSyncer.listeningTimerRunning)
  let gate = Promise.resolve(false) // the switch, read once by start()
  let queue = Promise.resolve() // every rule runs here, one after the other, like Kotlin's main thread

  const run = (fn) => {
    const p = queue.then(() => gate).then((on) => (on ? fn() : OFF))
    queue = p.then(() => {}, (e) => log('sleep: ' + (e && e.message)))
    return p
  }
  const later = (fn) => {
    run(fn).catch((e) => log('sleep: ' + (e && e.message)))
  }

  // ---- native connectors (a failed call is logged; the timer keeps going)
  const native = (connector, method, args = {}) =>
    bridge.call(connector, method, args).catch((e) => {
      log(`sleep: ${connector}.${method} failed: ${e && e.message}`)
      return undefined
    })
  const position = async () => (await native('player', 'getPosition')) || { live: false, playing: false, positionSec: 0, rate: 1 }
  const playerState = async () => (await native('player', 'getState')) || { live: false, playing: false, positionSec: 0, rate: 1, session: null }
  const setVolume = (volume) => native('player', 'setVolume', { volume }) // SleepTimerManager.kt:68-70
  const pausePlayer = () => native('player', 'pause') // :73-75
  const playPlayer = () => native('player', 'play') // :78-80
  const seekBackward = (ms) => native('player', 'seekBackward', { ms }) // :331 playerNotificationService.seekBackward
  const settings = async () => ((await db.methods.getDeviceData()) || {}).deviceSettings || {}

  const emitSet = (value, isAuto = S.isAuto) => emitToUi('sleepTimerSet', { value, isAuto }) // :139-142, :158-161, :247, :413, :442, :538
  const remainingOf = (p) => remainingSecOf(S, p.rate ?? 1, msOf(p.positionSec)) // :140, :537

  // ---- feedback (SleepTimerManager.kt:250-285)
  async function vibrate() {
    if ((await settings()).disableSleepTimerResetFeedback === true) return // :252
    await native('feedback', 'vibrate', { pattern: VIBRATE_PATTERN })
  }
  async function chime() {
    await native('feedback', 'chime', { volume: CHIME_VOLUME }) // :276-283
  }

  // ---- sensor (PlayerNotificationService.kt:2065-2095). The 2 minute window is the core's: it asks for an immediate unregister.
  const sensorRegister = () => native('sensor', 'register') // SleepTimerManager.kt:137 registerSensor
  // PlayerNotificationService.kt:2086-2088 unregisterSensor schedules the unregister 2 min later (a new call replaces the wait).
  // A register does NOT cancel a pending unregister: Kotlin's registerSensor returns early when already registered (:2066-2070).
  const sensorOffLater = () =>
    tick.start(SENSOR_OFF_ID, {
      everyMs: WAKE_UP_EXPIRATION_MS,
      onTick: () => {
        tick.stop(SENSOR_OFF_ID)
        native('sensor', 'unregister')
      }
    })

  // ---- the rules
  async function clearSleepTimer() {
    await tick.stop(TICK_ID) // SleepTimerManager.kt:220-221
    S.endMs = 0 // :222
    S.running = false // :223
    await sensorOffLater() // :224 unregisterSensor
    await setVolume(1) // :226
  }

  async function setSleepTimer(timeMs) {
    await tick.stop(TICK_ID) // :103 sleepTimerTask?.cancel()
    S.running = true // :104
    S.finishedAt = 0 // :105
    S.elapsedMs = 0 // :106
    await setVolume(1) // :107

    if (timeMs === 0) { // :109 end of chapter or track
      const st = await playerState()
      const s = st.session || null
      const ms = msOf(st.positionSec)
      const end = chapterEndTimeFor(s, ms) // :111
      if (end == null) { // :113-116
        log('sleep: end of chapter but there is no session or no next chapter')
        return false
      }
      if (ms > end) { // :118-122
        log('sleep: invalid, the time is already past the chapter end')
        return false
      }
      S.endMs = end // :124
      if (S.endMs > totalDurationMs(s)) S.endMs = totalDurationMs(s) // :126-128
    } else {
      S.endMs = 0 // :130
    }
    S.lengthMs = timeMs // :134

    await sensorRegister() // :137
    emitSet(remainingOf(await position())) // :139-142
    const started = await tick.start(TICK_ID, { everyMs: TICK_MS, onTick: () => later(tickBody) }) // :144-145
    if (started && started.error) log('sleep: the tick could not be scheduled: ' + started.error)
    later(tickBody) // Timer.schedule(0L, ...) runs the first tick at once
    return true // :196
  }

  /** SleepTimerManager.kt:145-195, one tick. Runs on the core's 1 s timer. */
  async function tickBody() {
    const p = await position()
    if (!p.playing) return // :147 if (getIsPlaying())
    S.elapsedMs += 1000 // :148
    const cur = msOf(p.positionSec)
    const remaining = remainingSecOf(S, p.rate ?? 1, cur) // :151
    if (remaining > 0) emitSet(remaining) // :157-161
    if (remaining === ALMOST_DONE_SEC && S.elapsedMs > 1 && (await settings()).enableSleepTimerAlmostDoneChime === true) {
      await chime() // :164-166
    }
    if (remaining <= 0) { // :168
      await pausePlayer() // :170
      emitToUi('sleepTimerEnded', { value: cur }) // :172-174
      await clearSleepTimer() // :175
      S.finishedAt = now() // :176
    } else if (remaining <= FADE_SEC && (await settings()).disableSleepTimerFadeOut !== true) { // :177-180
      const percentToReduce = 1 - remaining / 60 // :183
      await setVolume(1 - percentToReduce * (1 - FADE_FLOOR)) // :184-189 (0.9 = 1 - 0.1)
    } else {
      await setVolume(1) // :190-191
    }
  }

  async function setManual({ ms, isChapterTime, sessionId }) { // SleepTimerManager.kt:206-216
    S.sleepSessionId = sessionId || '' // :207
    S.isAuto = false // :208
    return isChapterTime ? setSleepTimer(0) : setSleepTimer(ms) // :209-215
  }

  async function cancel() { // :238-248
    if (S.isAuto) S.autoDisabled = true // :241-244
    await clearSleepTimer() // :246
    emitSet(0, false) // :247
  }

  async function vibrateAndRestart() {
    await vibrate()
    await setSleepTimer(S.lengthMs)
    await playPlayer()
  }

  /** SleepTimerManager.kt:324-334 tryRewindAutoSleepTimer */
  async function tryRewindAutoSleepTimer() {
    const d = await settings()
    if (S.isAuto && d.autoSleepTimerAutoRewind) {
      await seekBackward(d.autoSleepTimerAutoRewindTime) // :331
    }
  }

  /** SleepTimerManager.kt:337-376 checkShouldResetSleepTimer */
  async function checkShouldReset() {
    if (S.running) {
      // Reset when it has run for more than 3 s, or it is an end of chapter/track timer (:339-341)
      if (S.lengthMs === 0 || S.elapsedMs > RESET_AFTER_ELAPSED_MS) await vibrateAndRestart() // :342-345
      return
    }
    if (S.finishedAt <= 0) return // :349
    const distance = now() - S.finishedAt // :351
    if (distance > WAKE_UP_EXPIRATION_MS) { // :352
      S.finishedAt = 0 // :355
      return
    }
    if (S.lengthMs === 1000) { // :361 cleared by subtracting time
      S.finishedAt = 0 // :363
      return
    }
    await tryRewindAutoSleepTimer() // :368
    await vibrateAndRestart() // :372-374
  }

  /** SleepTimerManager.kt:382-390 handleShake */
  async function handleShake() {
    const playing = S.running ? (await position()).playing === true : false // :383
    if ((S.running && playing) || S.finishedAt > 0) {
      if ((await settings()).disableShakeToResetSleepTimer === true) return // :384-387
      await checkShouldReset() // :388
    }
  }

  /** SleepTimerManager.kt:396-417 increaseSleepTime */
  async function increase(ms) {
    if (!S.running) return // :398
    const st = await playerState()
    const speed = st.rate ?? 1
    const cur = msOf(st.positionSec)
    const dur = totalDurationMs(st.session)
    if (S.endMs === 0) { // :402 fixed length
      S.lengthMs += ms // :404
      S.lengthMs = Math.min(S.lengthMs, dur - cur) // :405
    } else { // chapter end time
      S.endMs = Math.min(S.endMs + Math.round(ms * speed), dur) // :408-409
    }
    await setVolume(1) // :412
    emitSet(remainingSecOf(S, speed, cur)) // :413-416
  }

  /** SleepTimerManager.kt:423-446 decreaseSleepTime */
  async function decrease(ms) {
    if (!S.running) return // :425
    const st = await playerState()
    const speed = st.rate ?? 1
    const cur = msOf(st.positionSec)
    if (S.endMs === 0) { // :429 fixed length
      S.lengthMs = Math.max(S.lengthMs - ms, 1000) // :431
    } else { // chapter end time
      S.endMs = Math.max(S.endMs - Math.round(ms * speed), cur + 1000) // :434-438
    }
    await setVolume(1) // :441
    emitSet(remainingSecOf(S, speed, cur)) // :442-445
  }

  /** SleepTimerManager.kt:449-512 checkAutoSleepTimer */
  async function checkAutoSleepTimer() {
    if (S.running) return // :450-452
    const d = await settings()
    if (d.autoSleepTimer !== true) return // :454
    const t = now()
    const start = new Date(t)
    const [sh, sm] = parseHM(d.autoSleepTimerStartTime)
    start.setHours(sh, sm) // :456-458 (seconds and ms stay those of now, as Calendar does)
    const end = new Date(t)
    const [eh, em] = parseHM(d.autoSleepTimerEndTime)
    end.setHours(eh, em) // :459-461
    const current = new Date(t) // :463
    if (end < start) { // :472 the window crosses midnight
      if (current < start) start.setDate(start.getDate() - 1) // :473-474
      else end.setDate(end.getDate() + 1) // :476
    }
    const duringAutoTime = current > start && current < end // :480-481
    if (S.autoDisabled) { // :484
      if (!duringAutoTime) S.autoDisabled = false // :487
    } else if (duringAutoTime) { // :494
      await tryRewindAutoSleepTimer() // :501 (before isAuto is set: the first rewind of the period does not happen)
      S.isAuto = true // :505
      await setSleepTimer(d.sleepTimerLength) // :506
    }
  }

  /** SleepTimerManager.kt:518-529 handleMediaPlayEvent */
  async function handleMediaPlayEvent(sessionId) {
    if (S.sleepSessionId === sessionId || S.running) await checkShouldReset() // :523-524
    S.sleepSessionId = sessionId // :526
    await checkAutoSleepTimer() // :528
  }

  /** SleepTimerManager.kt:535-543 sendCurrentSleepTimerState */
  async function resend() {
    if (S.running) emitSet(remainingOf(await position())) // :536-538
    else emitSet(0, false) // :541
  }

  // The 15 s auto check: MediaProgressSyncer.kt:81-83 (inside the tick, only while playing)
  async function autoTickBody() {
    const p = await position()
    if (p.playing) await checkAutoSleepTimer()
  }
  // MediaProgressSyncer.kt:55-80 start(): a running timer for the same session is kept; another session restarts it
  async function startAuto(sessionId) {
    if (autoSession !== null && autoSession === sessionId) return
    autoSession = sessionId
    await tick.start(AUTO_ID, { everyMs: AUTO_TICK_MS, onTick: () => later(autoTickBody) })
  }
  // MediaProgressSyncer.kt:146-151 pause (and :114-122 stop, :181-186 finished) cancel the timer
  async function stopAuto() {
    if (autoSession === null) return
    autoSession = null
    await tick.stop(AUTO_ID)
  }

  /** player/state from PlayerConnector.emitState: the same events PlayerListener sends to Kotlin's sleep timer */
  async function onPlayerState(d) {
    if (d.reason === 'playing') {
      if (!d.sessionId) return // PlayerListener.kt:103 playbackSession?.let
      await handleMediaPlayEvent(d.sessionId) // PlayerListener.kt:104
      await setVolume(1) // PlayerListener.kt:106 "Volume on sleep timer might have decreased this"
      await startAuto(d.sessionId) // PlayerListener.kt:108 mediaProgressSyncer.play
    } else if (d.reason === 'paused' || d.reason === 'closed') {
      await stopAuto() // PlayerListener.kt:111 pause; closed: the syncer stops on close (PlayerNotificationService.kt:1056)
    }
  }

  /** Serves a call from native. Answers {ok} or {ok: false, off: true} while the switch is off. */
  const serve = (fn) => async (args) => {
    const r = await run(() => fn(args || {}))
    return r === OFF ? { ok: false, off: true } : r
  }

  function start() {
    gate = bridge
      .call('system', 'flags', {})
      .then(
        (f) => f?.coreSleep === true,
        (e) => {
          log('sleep: the switch could not be read, the core sleep timer stays off: ' + (e && e.message))
          return false
        }
      )
    bridge.on('player', 'state', (d) => later(() => onPlayerState(d)))
    bridge.on('sensor', 'shake', () => later(handleShake)) // SleepTimerManager.kt:382 (via PlayerNotificationService.kt:2058)
    bridge.serve('sleep', 'set', serve((a) => setManual(a).then((ok) => ({ ok }))))
    bridge.serve('sleep', 'increase', serve((a) => increase(a.ms).then(() => ({ ok: true }))))
    bridge.serve('sleep', 'decrease', serve((a) => decrease(a.ms).then(() => ({ ok: true }))))
    bridge.serve('sleep', 'cancel', serve(() => cancel().then(() => ({ ok: true }))))
    bridge.serve('sleep', 'resend', serve(() => resend().then(() => ({ ok: true }))))
  }

  return {
    start,
    /** For tests and the diagnostics: the state the rules hold */
    state: () => ({ ...S, autoSession }),
    // Exposed for the tests of the rules that run without a call
    checkAutoSleepTimer: () => run(checkAutoSleepTimer),
    handleShake: () => run(handleShake),
    tickNow: () => run(tickBody)
  }
}
