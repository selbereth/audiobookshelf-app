import assert from 'assert'
import { execSync } from 'child_process'
import { castModule, switchPlan, volumeSet, volumeAdjust } from './modules/cast'

// Every test quotes the Kotlin line it ports (read from master, so a drifted quote fails the test)
const ROOT = process.cwd()
const MASTER = '6f77a75a'
const PNS = 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerNotificationService.kt'
const lines = {}
function quote(file, line, needle) {
  if (!lines[file]) lines[file] = execSync(`git show ${MASTER}:${file}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = lines[file][line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${file}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}

// Fake bridge: system.flags, and the served methods
function world({ coreCast = true } = {}) {
  const servers = new Map()
  const bridge = {
    call: (c, m) => (c === 'system' && m === 'flags' ? Promise.resolve({ coreCast }) : Promise.resolve({})),
    on: () => {},
    serve: (c, m, fn) => servers.set(c + '/' + m, fn)
  }
  const cast = castModule(bridge, { log: () => {} })
  cast.start()
  const ask = (m, args) => servers.get('cast/' + m)(args)
  return { ask }
}

const tests = {
  'switch to the Cast player from the local one stops the local player (PlayerNotificationService.kt:720)': async () => {
    quote(PNS, 720, 'mPlayer.stop()')
    assert.deepStrictEqual(switchPlan({ useCast: true, current: 'exo', hasCastPlayer: true, wasPlaying: false }), { noop: false, stop: 'exo', notifyPaused: false })
  },

  'switch to the Cast player while it is already in use does nothing (PlayerNotificationService.kt:715-717)': async () => {
    quote(PNS, 715, 'if (currentPlayer == castPlayer) {')
    assert.deepStrictEqual(switchPlan({ useCast: true, current: 'cast', hasCastPlayer: true, wasPlaying: true }), { noop: true, stop: null, notifyPaused: false })
  },

  'switch to the local player from Cast stops the Cast player when there is one (PlayerNotificationService.kt:726-729)': async () => {
    quote(PNS, 726, 'else if (castPlayer != null) {')
    quote(PNS, 728, 'castPlayer?.stop()')
    assert.deepStrictEqual(switchPlan({ useCast: false, current: 'cast', hasCastPlayer: true, wasPlaying: false }), { noop: false, stop: 'cast', notifyPaused: false })
    assert.deepStrictEqual(switchPlan({ useCast: false, current: 'cast', hasCastPlayer: false, wasPlaying: false }), { noop: false, stop: null, notifyPaused: false })
  },

  'switch to the local player while it is already in use does nothing (PlayerNotificationService.kt:723-725)': async () => {
    quote(PNS, 723, 'if (currentPlayer == mPlayer) {')
    assert.deepStrictEqual(switchPlan({ useCast: false, current: 'exo', hasCastPlayer: true, wasPlaying: true }), { noop: true, stop: null, notifyPaused: false })
  },

  'a switch while playing reports the pause, a switch while paused does not (PlayerNotificationService.kt:765-766)': async () => {
    quote(PNS, 765, 'if (wasPlaying) { // media is paused when switching players')
    quote(PNS, 766, 'clientEventEmitter?.onPlayingUpdate(false)')
    assert.strictEqual(switchPlan({ useCast: true, current: 'exo', hasCastPlayer: true, wasPlaying: true }).notifyPaused, true)
    assert.strictEqual(switchPlan({ useCast: true, current: 'exo', hasCastPlayer: true, wasPlaying: false }).notifyPaused, false)
  },

  'the device volume is clamped to 0 to 100 when set (PlayerNotificationService.kt:779-781)': async () => {
    quote(PNS, 779, 'val clamped = volume.coerceIn(0, 100)')
    assert.strictEqual(volumeSet(150), 100)
    assert.strictEqual(volumeSet(-5), 0)
    assert.strictEqual(volumeSet(50), 50)
  },

  'the device volume steps by the direction and stays in 0 to 100 (PlayerNotificationService.kt:786-787)': async () => {
    quote(PNS, 787, 'val target = (current + direction).coerceIn(0, 100)')
    assert.strictEqual(volumeAdjust(40, 1), 41)
    assert.strictEqual(volumeAdjust(100, 1), 100)
    assert.strictEqual(volumeAdjust(0, -1), 0)
    assert.strictEqual(volumeAdjust(50, -1), 49)
  },

  'served through the bridge: the answer carries ok and the plan': async () => {
    const w = world()
    assert.deepStrictEqual(await w.ask('switchPlan', { useCast: true, current: 'exo', hasCastPlayer: true, wasPlaying: true }), { ok: true, noop: false, stop: 'exo', notifyPaused: true })
    assert.deepStrictEqual(await w.ask('volumeAdjust', { current: 99, direction: 1 }), { ok: true, volume: 100 })
    assert.deepStrictEqual(await w.ask('volumeSet', { volume: 300 }), { ok: true, volume: 100 })
  },

  'switch off: the core answers off and decides nothing': async () => {
    const w = world({ coreCast: false })
    assert.deepStrictEqual(await w.ask('switchPlan', { useCast: true, current: 'exo', hasCastPlayer: true, wasPlaying: true }), { ok: false, off: true })
    assert.deepStrictEqual(await w.ask('volumeSet', { volume: 5 }), { ok: false, off: true })
  },
}

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
console.log(`cast: ${passed} ok${failed ? ', ' + failed + ' failed' : ''}`)
if (failed) process.exit(1)
