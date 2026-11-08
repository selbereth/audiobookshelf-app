import assert from 'assert'
import { execSync } from 'child_process'
import { pauseSeekBackMs, pauseSeekAmountMs, playerModule } from './modules/player'

// Every test quotes the Kotlin line it ports. `quote` reads that line from the Kotlin source at master 96f28d39 and checks the
// needle is on it, so a quoted line that drifts from the source fails the test.
const ROOT = process.cwd()
const MASTER = '96f28d39'
const FILE = 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerListener.kt'
let lines = null
function quote(line, needle) {
  if (!lines) lines = execSync(`git show ${MASTER}:${FILE}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = lines[line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${FILE}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}

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
