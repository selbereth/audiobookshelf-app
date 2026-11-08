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
 * Slice 2: the media buttons (MediaSessionCallback.kt: click counting, play/pause, jumps, stop) and the speed cycle.
 * Calls in (native forwards them while corePlayer is on and CoreHost is ready): player/mediaKey {keyCode, action}, player/speedCycle {rate}.
 *
 * Kept native (see the vault questions): the buffering and lazy-play filters that decide which events exist.
 */
import { chapterAt, chapterStartMs, totalDurationMs } from './sleep'

// KeyEvent codes (android.view.KeyEvent) and actions, as MediaSessionCallback.kt uses them
export const KEY = { HEADSETHOOK: 79, STOP: 86, NEXT: 87, PREVIOUS: 88, REWIND: 89, FAST_FORWARD: 90, PLAY: 126, PAUSE: 127, PLAY_PAUSE: 85 }
export const ACTION_DOWN = 0
export const ACTION_UP = 1
export const MEDIA_BUTTON_CLICK_TIMEOUT_MS = 1000 // MediaSessionCallback.kt:18 mediaButtonClickTimeout = 1000 (ms)
export const CLICK_ID = 'mediaClick'

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

export function playerModule(bridge, { db, tick, server = null, now = () => Date.now(), log = () => {} } = {}) {
  let pausedAt = 0 // PlayerListener.lastPauseTime (ms, native clock); 0 = no pause to measure
  let clicks = 0 // MediaSessionCallback.mediaButtonClickCount
  let gate = Promise.resolve(false) // the switch, read once by start()
  let queue = Promise.resolve() // one rule at a time, like Kotlin's main thread

  const later = (fn) => {
    const p = queue.then(() => gate).then((on) => (on ? fn() : null))
    queue = p.then(() => {}, (e) => log('player: ' + (e && e.message)))
    return p
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

  // ---- slice 2: the media buttons (MediaSessionCallback.kt:176-263) and the speed cycle (:109-122)
  /** Performs one step of a plan on the player (the same calls the Kotlin service makes) */
  async function perform(step) {
    if (step === 'pause') return native('player', 'pauseService') // playerNotificationService.pause()
    if (step === 'play') return native('player', 'playService') // playerNotificationService.play()
    if (step === 'jumpBackward') return native('player', 'jump', { forward: false }) // jumpBackward()
    if (step === 'jumpForward') return native('player', 'jump', { forward: true }) // jumpForward()
  }

  /** One click of the counter (MediaSessionCallback.kt:271-279): the first click starts the 1 s window */
  async function countClick() {
    clicks++ // :272
    if (clicks === 1) { // :273
      await tick.start(CLICK_ID, {
        everyMs: MEDIA_BUTTON_CLICK_TIMEOUT_MS,
        onTick: () => later(async () => {
          await tick.stop(CLICK_ID)
          const n = clicks // :275 sendEmptyMessage(mediaButtonClickCount)
          clicks = 0 // :276
          for (const step of clickWindowPlan(n)) await perform(step) // :286-293
        })
      })
    }
  }

  async function mediaKey({ keyCode, action }) {
    const p = (await native('player', 'getPosition')) || {}
    const plan = mediaKeyPlan({ keyCode, action, isPlaying: p.playing === true, clicks })
    for (const step of plan.steps) await perform(step)
    if (plan.click) await countClick()
    return { handled: plan.handled }
  }

  async function speedCycle({ rate }) {
    await native('player', 'setSpeed', { speed: nextSpeed(rate) }) // MediaSessionCallback.kt:109-122 onChangeSpeed
  }

  // ---- slice 3 (item 2): chapter skip (player/skipChapter {forward}) through chapterSkipModule
  const skip = chapterSkipModule(native, totalDurationMs)
  const skipChapter = async (d) => skip(d, await native('player', 'getState'))

  // ---- slice 4 (item 4): the playback error fallback through the core's server.playItem (needs server)
  const playbackError = server ? playbackErrorModule(native, server) : null
  const onPlaybackError = (d) => (playbackError ? playbackError(d) : null)

  function start() {
    gate = bridge
      .call('system', 'flags', {})
      .then(
        (f) => f?.corePlayer === true,
        (e) => {
          log('player: the switch could not be read, the core player rules stay off: ' + (e && e.message))
          return false
        }
      )
    bridge.on('player', 'state', (d) => later(() => onPlayerState(d)))
    bridge.on('player', 'mediaKey', (d) => later(() => mediaKey(d)))
    bridge.on('player', 'speedCycle', (d) => later(() => speedCycle(d)))
    bridge.on('player', 'skipChapter', (d) => later(() => skipChapter(d)))
    bridge.on('player', 'playbackError', (d) => later(() => onPlaybackError(d)))
  }

  return {
    start,
    /** For tests: the pause time and click count the rules hold */
    pausedAt: () => pausedAt,
    clicks: () => clicks,
    /** For tests: the rules without a native event; resolves when they are done */
    handlePlayerState: (d) => later(() => onPlayerState(d)),
    handleMediaKey: (d) => later(() => mediaKey(d)),
    handleSpeedCycle: (d) => later(() => speedCycle(d)),
    handleSkipChapter: (d) => later(() => skipChapter(d)),
    handlePlaybackError: (d) => later(() => onPlaybackError(d))
  }
}

/** MediaSessionCallback.kt:109-122 onChangeSpeed: the next preset speed. Float ranges as Kotlin compares them (Math.fround). */
export function nextSpeed(rate) {
  const r = Math.fround(rate)
  const within = (lo, hi) => r >= Math.fround(lo) && r <= Math.fround(hi)
  if (within(0.5, 0.7)) return 1.0 // :114
  if (within(0.8, 1.0)) return 1.2 // :115
  if (within(1.1, 1.2)) return 1.5 // :116
  if (within(1.3, 1.5)) return 2.0 // :117
  if (within(1.6, 2.0)) return 3.0 // :118
  if (within(2.1, 3.0)) return 0.5 // :119
  return 1.0 // :121 anything else (also 0.75, 1.25 ...) goes back to 1
}

/**
 * MediaSessionCallback.kt:176-263 handleCallMediaButton, one key event. Returns the steps to do now, whether the press is
 * counted (handleMediaButtonClickCount), and whether the key is handled (false: Kotlin returns false for an unknown key-up).
 * Steps: pause, play, jumpBackward, jumpForward (native: pauseService, playService, jump).
 */
export function mediaKeyPlan({ keyCode, action, isPlaying, clicks }) {
  const first = clicks === 0 // MediaSessionCallback.kt:207, :210, :232, :242, :249 `if (0 == mediaButtonClickCount)`
  if (action === ACTION_DOWN) {
    if (keyCode === KEY.PLAY_PAUSE) { // :188
      if (isPlaying) return { steps: first ? ['pause'] : [], click: true, handled: true } // :206-208
      return { steps: first ? ['play'] : [], click: true, handled: true } // :210-213
    }
    if (keyCode === KEY.FAST_FORWARD) return { steps: ['jumpForward'], click: false, handled: true } // :216-218
    if (keyCode === KEY.REWIND) return { steps: ['jumpBackward'], click: false, handled: true } // :220-222
    return { steps: [], click: false, handled: true } // :185 ACTION_DOWN, not a key of this block: nothing, still handled (:268 return true)
  }
  if (action === ACTION_UP) {
    if (keyCode === KEY.HEADSETHOOK) { // :230
      if (!first) return { steps: [], click: true, handled: true }
      return { steps: [isPlaying ? 'pause' : 'play'], click: true, handled: true } // :232-237
    }
    if (keyCode === KEY.PLAY) return { steps: first ? ['play'] : [], click: true, handled: true } // :240-245
    if (keyCode === KEY.PAUSE) return { steps: first ? ['pause'] : [], click: true, handled: true } // :247-250
    if (keyCode === KEY.NEXT) return { steps: ['jumpForward'], click: false, handled: true } // :252-253
    if (keyCode === KEY.PREVIOUS) return { steps: ['jumpBackward'], click: false, handled: true } // :255-256
    if (keyCode === KEY.STOP) return { steps: ['pause'], click: false, handled: true } // :258-259
    return { steps: [], click: false, handled: false } // :261-263 else -> return false
  }
  return { steps: [], click: false, handled: true } // neither down nor up: Kotlin returns true at the end (:299)
}

/** MediaSessionCallback.kt:286-293: what the click window does when it ends with n presses */
export function clickWindowPlan(n) {
  if (n === 2) return ['jumpBackward', 'play'] // :286-289
  if (n >= 3) return ['jumpForward', 'play'] // :290-293
  return [] // one press: nothing (it was the play or pause already)
}

// ---- slice 3 (item 2): chapter skip, track maths, the seek clamp. Quotes: web AudioPlayer.vue (chapter rules, master 96f28d39),
// PlaybackSession.kt (tracks), PlayerNotificationService.kt (seekPlayer).

/** AudioPlayer.vue:447 / :452 use the start and end rounded to 2 decimals (toFixed(2)), compared with the position in seconds */
const r2 = (n) => Number(Number(n).toFixed(2))

/** AudioPlayer.vue:446-447 currentChapter (the chapter containing the position) */
export function chapterAtSec(chapters, t) {
  return (chapters || []).find((ch) => r2(ch.start) <= t && r2(ch.end) > t) || null
}

/** AudioPlayer.vue:449-452 nextChapter: the first chapter that starts after the position */
export function nextChapterAtSec(chapters, t) {
  return (chapters || []).find((c) => r2(c.start) > t) || null
}

/**
 * AudioPlayer.vue:579-584 jumpNextChapter: the seek target in seconds, or null (no seek: there is no next chapter).
 * Quirk kept: the start is compared rounded, but the seek goes to the chapter's own start.
 */
export function nextChapterTarget(chapters, t) {
  const next = nextChapterAtSec(chapters, t)
  return next ? next.start : null // AudioPlayer.vue:583-584
}

/**
 * AudioPlayer.vue:586-602 jumpChapterStart: the seek target in seconds, or null (no seek).
 * No current chapter: restart (seek 0), :590-591. Within 4 s of the chapter start: the previous chapter's start, if there is one
 * (:595-600), else nothing. Quirk kept: the previous-chapter search uses ch.end >= t (not rounded, not >), unlike currentChapter.
 * More than 4 s in: back to the start of the current chapter (:602).
 */
export function chapterBackTarget(chapters, t) {
  const cur = chapterAtSec(chapters, t)
  if (!cur) return 0 // :590-591 restart()
  if (t - cur.start <= 4) { // :595
    const idx = (chapters || []).findIndex((ch) => Number(ch.start) <= t && Number(ch.end) >= t) // :596
    if (idx > 0) return chapters[idx - 1].start // :597-599
    return null // first chapter, within 4 s: nothing happens
  }
  return cur.start // :602 this.seek(this.currentChapter.start)
}

/**
 * PlaybackSession.kt:90-99 getCurrentTrackIndex (the last track when none contains the time) and :136-140 getCurrentTrackTimeMs.
 * Input: the track list (startOffset, duration in seconds) and a time in ms. Returns {index, offsetMs}.
 */
export function trackAt(tracks, ms) {
  const list = tracks || []
  let index = list.length - 1 // :98 return audioTracks.size - 1
  for (let i = 0; i < list.length; i++) {
    const startMs = Math.trunc(list[i].startOffset * 1000)
    const endMs = startMs + Math.trunc(list[i].duration * 1000)
    if (ms >= startMs && endMs > ms) { index = i; break } // :93-94
  }
  const startMs = list.length ? Math.trunc(list[index].startOffset * 1000) : 0
  return { index, offsetMs: ms - startMs } // :137-139 currentTime - currentTrack.startOffset
}

/**
 * PlayerNotificationService.kt:986-1005 seekPlayer: the time is clamped to 0 .. duration (with duration - 2000 above it), then the
 * track index and offset are worked out for the player (:1000-1004). Quirk kept: with no session the duration is 0, so any time
 * above 0 becomes -2000 (Kotlin getDuration() is 0 with no session, :828-830).
 */
export function seekPlan({ ms, durationMs, tracks }) {
  let t = ms
  if (t < 0) t = 0 // :989-990
  else if (t > durationMs) t = durationMs - 2000 // :992-993
  const { index, offsetMs } = trackAt(tracks, t)
  return { ms: t, index, offsetMs }
}

/**
 * The chapter skip, as a core decision (utils/core/modules/player.js). `player/skipChapter {forward}` from native (or the debug
 * emit): reads the position and the chapters from getState, works out the target and asks native `player.seekTo {ms, index, offsetMs}`.
 */
export function chapterSkipModule(native, totalDuration) {
  return async function skipChapter({ forward }, st) {
    if (!st || !st.live || !st.session) return null
    const chapters = st.session.chapters || []
    const t = st.positionSec
    const target = forward ? nextChapterTarget(chapters, t) : chapterBackTarget(chapters, t)
    if (target == null) return null
    const plan = seekPlan({ ms: Math.round(target * 1000), durationMs: totalDuration(st.session), tracks: st.session.audioTracks })
    await native('player', 'seekTo', plan)
    return plan
  }
}

// ---- slice 4 (item 4): restart near the end, the playback error fallback, play from id. Quotes: PlayerNotificationService.kt
// (preparePlayer, handlePlayerPlaybackError) and MediaSessionCallback.kt (onPlayFromMediaId), master 96f28d39.

/** PlayerNotificationService.kt:451-453: a session within 5 s of its end starts again from 0 */
export function restartPosition({ durationSec, currentSec }) {
  if (durationSec - currentSec < 5) return 0 // :451 duration - currentTime < 5, :453 currentTime = 0.0
  return currentSec
}

/**
 * PlayerNotificationService.kt:628-650 handlePlayerPlaybackError: a direct play (playMethod 0, PLAYMETHOD_DIRECTPLAY) asks the
 * server again with forceTranscode (:631-632); anything else is a failure (:648-649). PlayerConstants.kt:9.
 */
export function playbackErrorPlan({ playMethod }) {
  return playMethod === 0 ? 'transcode' : 'fail'
}

/** MediaSessionCallback.kt:131-132: an empty media id plays the first item; any other id is looked up (native lists are kept there) */
export function playFromIdPlan(mediaId) {
  return mediaId == null || mediaId === '' ? 'first' : 'lookup'
}

/**
 * The error fallback as a core decision. `player/playbackError {playMethod, errorMessage, libraryItemId, episodeId, payload,
 * playbackRate}` from native. A transcode: server.playItem with the payload native built with forceTranscode, then
 * player.loadSession. A failure, or a request that fails: player.closeOnError (Kotlin's onPlaybackFailed then closePlayback(true)).
 */
export function playbackErrorModule(native, server) {
  return async function onPlaybackError(d) {
    if (playbackErrorPlan(d) === 'fail') return native('player', 'closeOnError', { errorMessage: d.errorMessage }) // :647-649
    const r = await server.playItem({ libraryItemId: d.libraryItemId, episodeId: d.episodeId, payload: d.payload })
    if (!r || r.error || !r.id) return native('player', 'closeOnError', { errorMessage: d.errorMessage }) // :639-641
    return native('player', 'loadSession', { session: r, playbackRate: d.playbackRate }) // :643 preparePlayer(it, true, null)
  }
}
