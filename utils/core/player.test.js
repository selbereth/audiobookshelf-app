import assert from 'assert'
import { execSync } from 'child_process'
import { tickModule } from './modules/tick'
import { pauseSeekBackMs, pauseSeekAmountMs, playerModule, nextSpeed, mediaKeyPlan, clickWindowPlan, KEY, ACTION_DOWN, ACTION_UP } from './modules/player'

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
