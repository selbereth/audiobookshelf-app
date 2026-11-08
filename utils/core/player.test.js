import assert from 'assert'
import { execSync } from 'child_process'
import { tickModule } from './modules/tick'
import { pauseSeekBackMs, pauseSeekAmountMs, playerModule, nextSpeed, mediaKeyPlan, clickWindowPlan, KEY, ACTION_DOWN, ACTION_UP, nextChapterTarget, chapterBackTarget, trackAt, seekPlan, restartPosition, playbackErrorPlan, playFromIdPlan, browseTree } from './modules/player'

// Every test quotes the Kotlin line it ports. `quote` reads that line from the Kotlin source at master 96f28d39 and checks the
// needle is on it, so a quoted line that drifts from the source fails the test.
const ROOT = process.cwd()
const MASTER = '96f28d39'
const FILE = 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerListener.kt'
const MSC = 'android/app/src/main/java/com/audiobookshelf/app/player/MediaSessionCallback.kt'
const cache = {}
function quoteIn(file, line, needle) {
  if (!cache[file]) cache[file] = execSync(`git show ${MASTER}:${file}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = cache[file][line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${file}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}
function quote(line, needle) {
  return quoteIn(FILE, line, needle)
}
const quoteMsc = (line, needle) => quoteIn(MSC, line, needle)

const T0 = 1_000_000_000
const chapters = [
  { start: 0, end: 4 },
  { start: 4, end: 100 }
]
const session = { id: 'ps1', currentTime: 0, audioTracks: [{ startOffset: 0, duration: 100 }], chapters }

const tests = {
  'tiers: no seek under 10 s, then 3 s, 10 s, 20 s, 29.5 s (calcPauseSeekBackTime)': () => {
    quote(170, 'if (time < 10000) seekback = 0')
    quote(171, 'else if (time < 60000) seekback = 3000')
    quote(172, 'else if (time < 300000) seekback = 10000')
    quote(173, 'else if (time < 1800000) seekback = 20000')
    quote(174, 'else seekback = 29500')
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 9999), 0)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 10000), 3000)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 59999), 3000)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 60000), 10000)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 299999), 10000)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 300000), 20000)
    assert.strictEqual(pauseSeekBackMs(T0, T0 + 1800000), 29500)
  },

  'no pause to measure gives no seek (lastPauseTime <= 0)': () => {
    quote(167, 'if (lastPauseTime <= 0) return 0')
    assert.strictEqual(pauseSeekBackMs(0, T0 + 999999), 0)
    assert.strictEqual(pauseSeekBackMs(-1, T0 + 999999), 0)
  },

  'the seek back does not go before the start of the chapter (seekBackTime clamp)': () => {
    quote(75, 'val newTime = currentTime - seekBackTime')
    quote(76, 'if (newTime < minSeekBackTime) {')
    quote(77, 'seekBackTime = currentTime - minSeekBackTime')
    // 70 s pause gives 10 s; the position is 4.5 s and the chapter starts at 4 s: back only 0.5 s
    assert.strictEqual(pauseSeekAmountMs({ pausedAtMs: T0, nowMs: T0 + 70000, positionMs: 4500, chapter: { start: 4, end: 100 } }), 500)
    // Far from the chapter start: the full tier
    assert.strictEqual(pauseSeekAmountMs({ pausedAtMs: T0, nowMs: T0 + 70000, positionMs: 50000, chapter: { start: 4, end: 100 } }), 10000)
    // At the chapter start: nothing to seek back
    assert.strictEqual(pauseSeekAmountMs({ pausedAtMs: T0, nowMs: T0 + 70000, positionMs: 4000, chapter: { start: 4, end: 100 } }), 0)
  },

  'disableAutoRewind turns the seek back off (PlayerListener.kt:66)': () => {
    quote(66, 'if (lastPauseTime > 0 && DeviceManager.deviceData.deviceSettings?.disableAutoRewind != true)')
    assert.strictEqual(pauseSeekAmountMs({ pausedAtMs: T0, nowMs: T0 + 70000, disableAutoRewind: true, positionMs: 50000, chapter: null }), 0)
  },
}

// Fake native: the player position, the device settings, and the calls the rule makes
function world({ coreOn = true, disableAutoRewind = false, positionSec = 50, live = true } = {}) {
  const calls = []
  const handlers = new Map()
  const native = (connector, method, args) => {
    calls.push({ connector, method, args })
    if (connector === 'system' && method === 'flags') return Promise.resolve({ corePlayer: coreOn })
    if (connector === 'player' && method === 'getState') return Promise.resolve({ live, playing: false, positionSec, rate: 1, session })
    return Promise.resolve({})
  }
  const bridge = {
    call: native,
    on: (c, e, h) => handlers.set(c + '/' + e, h),
    serve: () => {}
  }
  const db = { methods: { getDeviceData: async () => ({ deviceSettings: { disableAutoRewind } }) } }
  const mod = playerModule(bridge, { db, now: () => T0, log: () => {} })
  mod.start()
  const event = async (d) => {
    handlers.get('player/state')(d)
    for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
  }
  return { calls, event, mod, named: (m) => calls.filter((c) => c.method === m) }
}

Object.assign(tests, {
  async 'core on: a play after a 70 s pause seeks back 10 s (the event times are the native clock)'() {
    const w = world({ positionSec: 50 })
    await w.event({ reason: 'paused', atMs: T0, sessionId: 'ps1' })
    await w.event({ reason: 'playing', atMs: T0 + 70000, sessionId: 'ps1' })
    assert.deepStrictEqual(w.named('seekBackward').map((c) => c.args), [{ ms: 10000 }])
  },

  async 'core on: a seek while paused clears the pause, so the next play does not seek (PlayerListener.kt:36)'() {
    quote(36, 'lastPauseTime = 0 // When seeking while paused reset the auto-rewind')
    const w = world({ positionSec: 50 })
    await w.event({ reason: 'paused', atMs: T0, sessionId: 'ps1' })
    await w.event({ reason: 'seeked', atMs: T0 + 1000, sessionId: 'ps1' })
    await w.event({ reason: 'playing', atMs: T0 + 70000, sessionId: 'ps1' })
    assert.strictEqual(w.named('seekBackward').length, 0)
  },

  async 'core on: a play with no earlier pause does not seek (the first play of a book)'() {
    const w = world({ positionSec: 50 })
    await w.event({ reason: 'playing', atMs: T0, sessionId: 'ps1' })
    assert.strictEqual(w.calls.filter((c) => c.connector === 'player').length, 0)
  },

  async 'core on: no player (not live) means no seek'() {
    const w = world({ live: false })
    await w.event({ reason: 'paused', atMs: T0, sessionId: 'ps1' })
    await w.event({ reason: 'playing', atMs: T0 + 70000, sessionId: 'ps1' })
    assert.strictEqual(w.named('seekBackward').length, 0)
  },

  async 'switch off: only the switch is read, nothing reacts to the events (Kotlin keeps the seek back)'() {
    const w = world({ coreOn: false, positionSec: 50 })
    await w.event({ reason: 'paused', atMs: T0, sessionId: 'ps1' })
    await w.event({ reason: 'playing', atMs: T0 + 70000, sessionId: 'ps1' })
    assert.deepStrictEqual(w.calls.map((c) => c.connector + '.' + c.method), ['system.flags'])
  },

  async 'the chapter clamp applies in the module too: 4.5 s into chapter 2 seeks back 0.5 s'() {
    const w = world({ positionSec: 4.5 })
    await w.event({ reason: 'paused', atMs: T0, sessionId: 'ps1' })
    await w.event({ reason: 'playing', atMs: T0 + 70000, sessionId: 'ps1' })
    assert.deepStrictEqual(w.named('seekBackward').map((c) => c.args), [{ ms: 500 }])
  },
})

// ---- slice 2: media keys, the click window, the speed cycle. The timers are the core's tick module, as in production.
function world2({ coreOn = true, playing = true, positionSec = 50 } = {}) {
  const calls = []
  const handlers = new Map()
  const timers = new Map()
  const clock = { t: T0 }
  const player = { playing }
  const native = (connector, method, args) => {
    calls.push({ connector, method, args })
    if (connector === 'system' && method === 'flags') return Promise.resolve({ corePlayer: coreOn })
    if (connector === 'timer') {
      if (method === 'schedule') timers.set(args.id, args.atMs)
      if (method === 'cancel') timers.delete(args.id)
      return Promise.resolve({})
    }
    if (connector === 'player' && method === 'getPosition') return Promise.resolve({ live: true, playing: player.playing, positionSec, rate: 1 })
    return Promise.resolve({})
  }
  const bridge = { call: native, on: (c, e, h) => { const k = c + '/' + e; if (!handlers.has(k)) handlers.set(k, new Set()); handlers.get(k).add(h) }, serve: () => {} }
  const tick = tickModule(bridge, { now: () => clock.t })
  const db = { methods: { getDeviceData: async () => ({ deviceSettings: {} }) } }
  const mod = playerModule(bridge, { db, tick, now: () => clock.t, log: () => {} })
  mod.start()
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)) }
  // runs the core's timers forward by ms, firing each due tick in order
  async function advance(ms) {
    const target = clock.t + ms
    await flush()
    for (;;) {
      let next = null
      for (const [id, due] of timers) if (due <= target && (next === null || due < next.due)) next = { id, due }
      if (!next) break
      clock.t = next.due
      timers.delete(next.id)
      for (const h of [...(handlers.get('timer/tick') || [])]) h({ id: next.id, atMs: next.due }, next.due)
      await flush()
    }
    clock.t = target
    await flush()
  }
  const key = async (keyCode, action) => {
    for (const h of [...(handlers.get('player/mediaKey') || [])]) h({ keyCode, action })
    await flush()
  }
  return { calls, advance, key, mod, flush, player, named: (m) => calls.filter((c) => c.method === m), timers, named2: () => calls.map((c) => c.connector + '.' + c.method) }
}

Object.assign(tests, {
  'speed cycle: the preset ladder, and the gap values go back to 1 (onChangeSpeed)'() {
    quoteMsc(113, 'val newSpeed = when (mediaManager.getSavedPlaybackRate())')
    quoteMsc(114, 'in 0.5f..0.7f -> 1.0f')
    quoteMsc(115, 'in 0.8f..1.0f -> 1.2f')
    quoteMsc(116, 'in 1.1f..1.2f -> 1.5f')
    quoteMsc(117, 'in 1.3f..1.5f -> 2.0f')
    quoteMsc(118, 'in 1.6f..2.0f -> 3.0f')
    quoteMsc(119, 'in 2.1f..3.0f -> 0.5f')
    quoteMsc(121, 'else -> 1.0f')
    assert.strictEqual(nextSpeed(0.6), 1.0)
    assert.strictEqual(nextSpeed(0.9), 1.2)
    assert.strictEqual(nextSpeed(1.0), 1.2)
    assert.strictEqual(nextSpeed(1.2), 1.5)
    assert.strictEqual(nextSpeed(1.4), 2.0)
    assert.strictEqual(nextSpeed(2.0), 3.0)
    assert.strictEqual(nextSpeed(2.5), 0.5)
    assert.strictEqual(nextSpeed(3.5), 1.0)
    assert.strictEqual(nextSpeed(0.75), 1.0, 'the gap between 0.7 and 0.8 is not a preset (Kotlin: else)')
  },

  'play/pause: while playing, the first press pauses; the presses inside the window do not repeat it (:206-208)'() {
    quoteMsc(206, 'if (playerNotificationService.mPlayer.isPlaying) {')
    quoteMsc(207, 'if (0 == mediaButtonClickCount) playerNotificationService.pause()')
    const a = mediaKeyPlan({ keyCode: KEY.PLAY_PAUSE, action: ACTION_DOWN, isPlaying: true, clicks: 0 })
    assert.deepStrictEqual(a, { steps: ['pause'], click: true, handled: true })
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.PLAY_PAUSE, action: ACTION_DOWN, isPlaying: false, clicks: 0 }).steps, ['play'])
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.PLAY_PAUSE, action: ACTION_DOWN, isPlaying: true, clicks: 1 }).steps, [])
  },

  'headset hook: toggles on the first press, counted (:232-238)'() {
    quoteMsc(232, 'if (0 == mediaButtonClickCount) {')
    quoteMsc(233, 'if (playerNotificationService.mPlayer.isPlaying)')
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.HEADSETHOOK, action: ACTION_UP, isPlaying: false, clicks: 0 }), { steps: ['play'], click: true, handled: true })
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.HEADSETHOOK, action: ACTION_UP, isPlaying: true, clicks: 0 }), { steps: ['pause'], click: true, handled: true })
  },

  'next and previous on key-up jump, not counted (:252-256); stop pauses (:258-259)'() {
    quoteMsc(252, 'KeyEvent.KEYCODE_MEDIA_NEXT -> {')
    quoteMsc(256, 'playerNotificationService.jumpBackward()')
    quoteMsc(259, 'playerNotificationService.pause()')
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.NEXT, action: ACTION_UP, isPlaying: true, clicks: 0 }), { steps: ['jumpForward'], click: false, handled: true })
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.PREVIOUS, action: ACTION_UP, isPlaying: true, clicks: 0 }), { steps: ['jumpBackward'], click: false, handled: true })
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.STOP, action: ACTION_UP, isPlaying: true, clicks: 0 }).steps, ['pause'])
  },

  'fast forward and rewind jump on key-down, not counted (:216-222)'() {
    quoteMsc(216, 'KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {')
    quoteMsc(220, 'KeyEvent.KEYCODE_MEDIA_REWIND -> {')
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.FAST_FORWARD, action: ACTION_DOWN, isPlaying: true, clicks: 0 }).steps, ['jumpForward'])
    assert.deepStrictEqual(mediaKeyPlan({ keyCode: KEY.REWIND, action: ACTION_DOWN, isPlaying: true, clicks: 0 }).steps, ['jumpBackward'])
  },

  'an unknown key-up is not handled (return false, :261-263)'() {
    quoteMsc(263, 'return false')
    assert.strictEqual(mediaKeyPlan({ keyCode: 999, action: ACTION_UP, isPlaying: true, clicks: 0 }).handled, false)
    assert.strictEqual(mediaKeyPlan({ keyCode: 999, action: ACTION_DOWN, isPlaying: true, clicks: 0 }).handled, true)
  },

  'click window: 2 presses jump back 1 step and play, 3 or more jump forward (:286-293)'() {
    quoteMsc(272, 'mediaButtonClickCount++')
    quoteMsc(273, 'if (1 == mediaButtonClickCount) {')
    quoteMsc(286, 'if (2 == msg.what) {')
    quoteMsc(290, 'else if (msg.what >= 3) {')
    assert.deepStrictEqual(clickWindowPlan(1), [])
    assert.deepStrictEqual(clickWindowPlan(2), ['jumpBackward', 'play'])
    assert.deepStrictEqual(clickWindowPlan(3), ['jumpForward', 'play'])
    assert.deepStrictEqual(clickWindowPlan(5), ['jumpForward', 'play'])
  },

  async 'core on: one press pauses, the window ends with one click and nothing else (1 s, :18)'() {
    quoteMsc(18, 'private var mediaButtonClickTimeout: Long = 1000')
    const w = world2({ playing: true })
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    assert.deepStrictEqual(w.named2().filter((x) => x.startsWith('player.')), ['player.getPosition', 'player.pauseService'])
    assert.strictEqual(w.mod.clicks(), 1)
    await w.advance(999)
    assert.strictEqual(w.mod.clicks(), 1, 'the window is 1 s')
    await w.advance(2)
    assert.strictEqual(w.mod.clicks(), 0)
    assert.strictEqual(w.named('jump').length, 0)
  },

  async 'core on: three presses in a second jump forward and play (the window ends at 1 s after the first)'() {
    const w = world2({ playing: true })
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    w.player.playing = false
    await w.advance(200)
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    await w.advance(1000)
    assert.deepStrictEqual(w.named('jump').map((c) => c.args), [{ forward: true }])
    assert.strictEqual(w.named('playService').length, 1)
  },

  async 'core on: two presses jump back then play (the window)'() {
    const w = world2({ playing: true })
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    await w.advance(1000)
    assert.deepStrictEqual(w.named('jump').map((c) => c.args), [{ forward: false }])
    assert.strictEqual(w.named('playService').length, 1)
  },

  async 'core on: the speed custom action sends the next preset to the player (setSpeed)'() {
    const w = world2()
    handlersSpeed(w)
    await w.flush()
    assert.deepStrictEqual(w.named('setSpeed').map((c) => c.args), [{ speed: 1.2 }])
  },

  async 'switch off: the core answers nothing but the switch (system.flags)'() {
    const w = world2({ coreOn: false })
    await w.key(KEY.PLAY_PAUSE, ACTION_DOWN)
    await w.advance(2000)
    assert.deepStrictEqual(w.named2(), ['system.flags'])
  },
})
function handlersSpeed(w) { w.mod.handleSpeedCycle({ rate: 1.0 }) }

// ---- slice 3 (item 2): chapter skip, track maths, the seek clamp
const AV = 'components/app/AudioPlayer.vue'
const PSN = 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerNotificationService.kt'
const PSE = 'android/app/src/main/java/com/audiobookshelf/app/data/PlaybackSession.kt'
const qv = (line, needle) => quoteIn(AV, line, needle)
const qp = (line, needle) => quoteIn(PSN, line, needle)
const qs = (line, needle) => quoteIn(PSE, line, needle)
const CH = [{ start: 0, end: 200 }, { start: 200, end: 400 }, { start: 400, end: 600 }]

Object.assign(tests, {
  'next chapter: the first chapter that starts after the position, seek to its start (AudioPlayer.vue:449-452, :583-584)'() {
    qv(452, "return this.chapters.find((c) => Number(Number(c.start).toFixed(2)) > this.currentTime)")
    qv(584, 'this.seek(this.nextChapter.start)')
    assert.strictEqual(nextChapterTarget(CH, 50), 200)
    assert.strictEqual(nextChapterTarget(CH, 200), 400, 'exactly on a chapter start: the next one, not this one')
    assert.strictEqual(nextChapterTarget(CH, 500), null, 'the last chapter: no seek')
  },

  'next chapter quirk: the start is rounded to 2 decimals for the comparison only (AudioPlayer.vue:452)'() {
    assert.strictEqual(nextChapterTarget([{ start: 0, end: 10 }, { start: 10.004, end: 20 }], 9.999), 10.004)
    assert.strictEqual(nextChapterTarget([{ start: 0, end: 10 }, { start: 10.004, end: 20 }], 10.001), null, 'start rounds to 10.00 which is not after 10.001')
  },

  'previous chapter: more than 4 s in goes to the current chapter start (AudioPlayer.vue:595, :602)'() {
    qv(595, 'if (this.currentTime - this.currentChapter.start <= 4) {')
    qv(602, 'this.seek(this.currentChapter.start)')
    assert.strictEqual(chapterBackTarget(CH, 250), 200)
  },

  'previous chapter: within 4 s goes to the previous chapter start (AudioPlayer.vue:596-599)'() {
    qv(596, 'const currChapterIndex = this.chapters.findIndex((ch) => Number(ch.start) <= this.currentTime && Number(ch.end) >= this.currentTime)')
    qv(597, 'if (currChapterIndex > 0) {')
    qv(599, 'this.seek(prevChapter.start)')
    assert.strictEqual(chapterBackTarget(CH, 203), 0, 'chapter 2 start is 200, within 4 s: previous is chapter 1 at 0')
  },

  'previous chapter quirks: first chapter within 4 s does nothing (null); no chapters restarts (AudioPlayer.vue:590-591)'() {
    qv(590, 'if (!this.currentChapter) {')
    assert.strictEqual(chapterBackTarget(CH, 2), null, 'no previous chapter: nothing happens, it does not restart')
    assert.strictEqual(chapterBackTarget([], 12), 0, 'no chapters: restart (seek 0)')
  },

  'track maths: the track that contains the time, and the offset into it (PlaybackSession.kt:90-99, :136-140)'() {
    qs(93, 'if (currentTimeMs >= track.startOffsetMs && (track.endOffsetMs > currentTimeMs)) {')
    qs(97, 'return audioTracks.size - 1')
    qs(138, 'val time = currentTime - currentTrack.startOffset')
    const TR = [{ startOffset: 0, duration: 100 }, { startOffset: 100, duration: 50 }]
    assert.deepStrictEqual(trackAt(TR, 120000), { index: 1, offsetMs: 20000 })
    assert.deepStrictEqual(trackAt(TR, 0), { index: 0, offsetMs: 0 })
    assert.deepStrictEqual(trackAt(TR, 150000), { index: 1, offsetMs: 50000 }, 'at the end of the last track: the last track (Kotlin :98)')
    assert.deepStrictEqual(trackAt(TR, 160000), { index: 1, offsetMs: 60000 }, 'past the end: the last track, offset past its length (quirk, kept)')
  },

  'seek clamp: below 0 is 0, above the duration is duration minus 2 s (seekPlayer :989-993)'() {
    qp(989, 'if (timeToSeek < 0) {')
    qp(992, '} else if (timeToSeek > getDuration()) {')
    const TR = [{ startOffset: 0, duration: 150 }]
    assert.strictEqual(seekPlan({ ms: -5, durationMs: 150000, tracks: TR }).ms, 0)
    assert.strictEqual(seekPlan({ ms: 151000, durationMs: 150000, tracks: TR }).ms, 148000)
    assert.strictEqual(seekPlan({ ms: 60000, durationMs: 150000, tracks: TR }).ms, 60000)
    assert.strictEqual(seekPlan({ ms: 5000, durationMs: 0, tracks: [] }).ms, -2000, 'quirk kept: no session, duration 0 (getDuration :828-830)')
  },

  async 'chapter skip in the core: getState gives the chapters, native gets player.seekTo with the clamped time, index and offset'() {
    const calls = []
    const handlers = new Map()
    const bridge = {
      call: (c, m, a) => {
        calls.push({ c, m, a })
        if (c === 'system') return Promise.resolve({ corePlayer: true })
        if (c === 'player' && m === 'getState') return Promise.resolve({ live: true, positionSec: 50, rate: 1, session: { chapters: CH, audioTracks: [{ startOffset: 0, duration: 600 }] } })
        return Promise.resolve({})
      },
      on: (c, e, h) => { handlers.set(c + '/' + e, h) },
      serve: () => {}
    }
    const mod = playerModule(bridge, { db: { methods: { getDeviceData: async () => ({ deviceSettings: {} }) } }, tick: { start: async () => {}, stop: async () => {} }, now: () => 0, log: () => {} })
    mod.start()
    await mod.handleSkipChapter({ forward: true })
    await new Promise((r) => setImmediate(r))
    assert.deepStrictEqual(calls.filter((x) => x.m === 'seekTo').map((x) => x.a), [{ ms: 200000, index: 0, offsetMs: 200000 }])
  },
})

// ---- slice 4 (item 4): restart near the end, the error fallback, play from id
const PSN4 = PSN
const MSC4 = MSC
const q4 = (line, needle) => quoteIn(PSN4, line, needle)
const qm4 = (line, needle) => quoteIn(MSC4, line, needle)

Object.assign(tests, {
  'restart near the end: within 5 s of the end the session starts from 0 (preparePlayer :451-453)'() {
    q4(451, 'if (playbackSession.duration - playbackSession.currentTime < 5) {')
    q4(453, 'playbackSession.currentTime = 0.0')
    assert.strictEqual(restartPosition({ durationSec: 600, currentSec: 596 }), 0)
    assert.strictEqual(restartPosition({ durationSec: 600, currentSec: 595 }), 595, 'exactly 5 s left is not within 5 s (strict <)')
    assert.strictEqual(restartPosition({ durationSec: 600, currentSec: 594 }), 594)
  },

  'error fallback: only a direct play is asked again with forceTranscode; the rest fails (handlePlayerPlaybackError :631, :648-649)'() {
    q4(631, 'if (playbackSession.isDirectPlay) {')
    q4(632, 'val playItemRequestPayload = getPlayItemRequestPayload(true)')
    q4(649, 'closePlayback(true)')
    assert.strictEqual(playbackErrorPlan({ playMethod: 0 }), 'transcode')
    assert.strictEqual(playbackErrorPlan({ playMethod: 1 }), 'fail', 'direct stream (1) is not a direct play')
    assert.strictEqual(playbackErrorPlan({ playMethod: 2 }), 'fail')
    assert.strictEqual(playbackErrorPlan({ playMethod: 3 }), 'fail')
  },

  'play from id: an empty id plays the first item, any other id is looked up (onPlayFromMediaId :131-132)'() {
    qm4(131, 'if (mediaId.isNullOrEmpty()) {')
    qm4(132, 'libraryItemWrapper = playerNotificationService.mediaManager.getFirstItem()')
    assert.strictEqual(playFromIdPlan(''), 'first')
    assert.strictEqual(playFromIdPlan(null), 'first')
    assert.strictEqual(playFromIdPlan('li_x'), 'lookup')
  },

  async 'error fallback in the core: transcode request, then loadSession with the new session; a failed request closes on error'() {
    const run = async (playItemResult, playMethod) => {
      const calls = []
      const handlers = new Map()
      const bridge = {
        call: (c, m, a) => {
          calls.push({ c, m, a })
          if (c === 'system') return Promise.resolve({ corePlayer: true })
          return Promise.resolve({})
        },
        on: (c, e, h) => { handlers.set(c + '/' + e, h) },
        serve: () => {}
      }
      const server = { playItem: async (a) => { calls.push({ c: 'server', m: 'playItem', a }); return playItemResult } }
      const mod = playerModule(bridge, { db: { methods: { getDeviceData: async () => ({ deviceSettings: {} }) } }, tick: { start: async () => {}, stop: async () => {} }, server, now: () => 0, log: () => {} })
      mod.start()
      await mod.handlePlaybackError({ playMethod, errorMessage: 'boom', libraryItemId: 'li_1', episodeId: null, payload: { forceTranscode: true }, playbackRate: 1.5 })
      await new Promise((r) => setImmediate(r))
      return calls.filter((x) => x.c !== 'system').map((x) => x.c + '.' + x.m)
    }
    assert.deepStrictEqual(await run({ id: 'sess2', audioTracks: [] }, 0), ['server.playItem', 'player.loadSession'])
    assert.deepStrictEqual(await run({ error: 'no connection' }, 0), ['server.playItem', 'player.closeOnError'])
    assert.deepStrictEqual(await run({ id: 'sess2' }, 2), ['player.closeOnError'], 'a transcode that failed is not asked again')
  },
})

// ---- slice 5 (item 5): the Android Auto browse tree
const BT = 'android/app/src/main/java/com/audiobookshelf/app/player/BrowseTree.kt'
const DC = 'android/app/src/main/java/com/audiobookshelf/app/data/DataClasses.kt'
const qb = (line, needle) => quoteIn(BT, line, needle)
const LIBS = [{ id: 'lib1', name: 'Books', icon: 'database', stats: { numAudioFiles: 4 } }, { id: 'lib2', name: 'Empty', icon: 'database', stats: { numAudioFiles: 0 } }]

Object.assign(tests, {
  'browse root: continue, recent, libraries, downloads, in that order (BrowseTree.kt:45-75)'() {
    qb(45, 'if (itemsInProgress.isNotEmpty()) {')
    qb(49, 'if (libraries.isNotEmpty()) {')
    qb(50, 'if (recentsLoaded) {')
    qb(75, 'rootList += downloadsMetadata')
    const t = browseTree({ inProgressCount: 2, libraries: LIBS, recentsLoaded: true })
    assert.deepStrictEqual(t.root.map((x) => x.id), ['__CONTINUE__', '__RECENTLY__', '__LIBRARIES__', '__DOWNLOADS__'])
  },

  'browse root: no continue without items in progress; no recent until the recents are loaded (:45, :50)'() {
    const t = browseTree({ inProgressCount: 0, libraries: LIBS, recentsLoaded: false })
    assert.deepStrictEqual(t.root.map((x) => x.id), ['__LIBRARIES__', '__DOWNLOADS__'])
  },

  'browse libraries: a library with no audio files is skipped (:57); one with no stats is kept'() {
    qb(57, 'if (library.stats?.numAudioFiles == 0) return@forEach')
    const t = browseTree({ inProgressCount: 0, libraries: [...LIBS, { id: 'lib3', name: 'Nostats', icon: 'x', stats: null }], recentsLoaded: false })
    assert.deepStrictEqual(t.children.__LIBRARIES__.map((x) => x.id), ['lib1', 'lib3'])
  },

  'browse quirk: the Libraries item shows when there are libraries, even if all have no audio (children empty)'() {
    const t = browseTree({ inProgressCount: 0, libraries: [{ id: 'lib2', name: 'Empty', icon: 'database', stats: { numAudioFiles: 0 } }], recentsLoaded: false })
    assert.ok(t.root.some((x) => x.id === '__LIBRARIES__'))
    assert.deepStrictEqual(t.children.__LIBRARIES__, [])
  },

  'recent children carry the __RECENTLY__ id prefix (DataClasses.kt:375)'() {
    quoteIn(DC, 375, 'mediaId = "__RECENTLY__$id"')
    const t = browseTree({ inProgressCount: 0, libraries: LIBS, recentsLoaded: true })
    assert.deepStrictEqual(t.children.__RECENTLY__.map((x) => x.id), ['__RECENTLY__lib1'])
  },

  async 'browse inputs from native: the core answers with player.setBrowseTree'() {
    const calls = []
    const handlers = new Map()
    const bridge = { call: (c, m, a) => { calls.push({ c, m, a }); return Promise.resolve(c === 'system' ? { corePlayer: true } : {}) }, on: (c, e, h) => handlers.set(c + '/' + e, h), serve: () => {} }
    const mod = playerModule(bridge, { db: { methods: {} }, tick: {}, now: () => 0, log: () => {} })
    mod.start()
    handlers.get('player/browseInputs')({ inProgressCount: 1, libraries: LIBS, recentsLoaded: false })
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    const set = calls.filter((x) => x.m === 'setBrowseTree')
    assert.strictEqual(set.length, 1)
    assert.deepStrictEqual(set[0].a.tree.root.map((x) => x.id), ['__CONTINUE__', '__LIBRARIES__', '__DOWNLOADS__'])
  },
})

let failed = 0
let passed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    passed++
  } catch (e) {
    failed++
    console.log('not ok - ' + name + '\n   ' + (e && e.message))
  }
}
console.log(`player: ${passed} ok${failed ? ', ' + failed + ' failed' : ''}`)
if (failed) process.exit(1)
