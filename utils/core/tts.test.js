import assert from 'assert'
import { execSync } from 'child_process'
import { tickModule } from './modules/tick'
import { ttsModule, INT_MAX, MIN_REMAINING_MS } from './modules/tts'
import { sleepModule } from './modules/sleep'

// Every test quotes the Kotlin line it ports (read from master, so the quote fails if the source drifts)
const ROOT = process.cwd()
const MASTER = '6f77a75a'
const SVC = 'android/app/src/main/java/com/audiobookshelf/app/tts/TtsService.kt'
const CTRL = 'android/app/src/main/java/com/audiobookshelf/app/tts/TtsController.kt'
const PLUG = 'android/app/src/main/java/com/audiobookshelf/app/plugins/AbsTts.kt'
const lines = {}
function quote(file, line, needle) {
  if (!lines[file]) lines[file] = execSync(`git show ${MASTER}:${file}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = lines[file][line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${file}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}

// Fake native: the clock, the timer connector (tick.js), the TTS pause, the UI emit and the switch.
function world({ coreTts = true, coreSleep = false, t0 = 1000000 } = {}) {
  const clock = { t: t0 }
  const calls = []
  const handlers = new Map()
  const servers = new Map()
  const timers = new Map() // id -> due ms
  const emits = []
  const native = (connector, method, args) => {
    calls.push(connector + '.' + method)
    if (connector === 'system' && method === 'flags') return Promise.resolve({ coreTts, coreSleep })
    if (connector === 'timer') {
      if (method === 'schedule') timers.set(args.id, args.atMs)
      if (method === 'cancel') timers.delete(args.id)
      return Promise.resolve({})
    }
    if (connector === 'ui' && method === 'emit') {
      emits.push({ event: args.event, data: args.data })
      return Promise.resolve({})
    }
    if (connector === 'tts' && method === 'pause') {
      calls.push('pause:' + args.reason)
      return Promise.resolve({})
    }
    return Promise.resolve({})
  }
  const bridge = {
    call: native,
    on: (c, e, h) => {
      const k = c + '/' + e
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k).add(h)
    },
    serve: (c, m, fn) => servers.set(c + '/' + m, fn)
  }
  const tick = tickModule(bridge, { now: () => clock.t })
  const tts = ttsModule(bridge, { tick, now: () => clock.t, log: () => {}, emitToUi: (event, data) => native('ui', 'emit', { event, data }) })
  tts.start()
  const sleep = sleepModule(bridge, { tick, db: { methods: { getDeviceData: async () => ({ deviceSettings: {} }) } }, now: () => clock.t, log: () => {}, emitToUi: () => {}, tts })
  sleep.start()
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
  // Native time runs forward: every tick due on the way fires, in order
  async function advance(ms) {
    const target = clock.t + ms
    await flush()
    for (;;) {
      let next = null
      for (const [id, due] of timers) if (due <= target && (next === null || due < next.due)) next = { id, due }
      if (!next) break
      clock.t = next.due
      for (const h of handlers.get('timer/tick') || []) h({ id: next.id, atMs: next.due }, clock.t)
      await flush()
    }
    clock.t = target
    await flush()
  }
  const serve = (method, args) => servers.get('sleep/' + method)(args)
  const sentenceDone = (nextSpine) => { for (const h of handlers.get('tts/sentenceDone') || []) h({ nextSpine }, clock.t) }
  const reset = () => { for (const h of handlers.get('tts/reset') || []) h({}, clock.t) }
  return { clock, calls, emits, timers, tts, sleep, advance, serve, sentenceDone, reset, flush, t0 }
}

const pauses = (w) => w.calls.filter((c) => c.startsWith('pause:'))
const last = (w) => w.emits[w.emits.length - 1]

const tests = {
  'fixed timer: pauses the read-aloud at the end, then tells the UI (TtsService.kt:208-212)': async () => {
    quote(SVC, 209, 'sleepEndsAt = 0')
    quote(SVC, 210, 'controller.pause("sleep")')
    const w = world()
    assert.deepStrictEqual(await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false }), { ok: true })
    assert.deepStrictEqual(last(w).data, { remainingMs: 60000, running: true, atChapterEnd: false })
    await w.advance(59999)
    assert.deepStrictEqual(pauses(w), [])
    await w.advance(1)
    assert.deepStrictEqual(pauses(w), ['pause:sleep'])
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false })
    assert.deepStrictEqual(w.calls.indexOf('pause:sleep') < w.calls.lastIndexOf('ui.emit'), true, 'pause comes before the UI is told')
  },

  'a zero-length timer ends at once, as postDelayed(0) does (TtsService.kt:217)': async () => {
    quote(SVC, 217, 'sleepHandler.postDelayed(sleepRunnable, ms)')
    const w = world()
    await w.serve('set', { target: 'tts', ms: 0, isChapterTime: false })
    assert.deepStrictEqual(pauses(w), ['pause:sleep'])
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false })
  },

  'end of chapter: pauses at the first sentence of a later section (TtsController.kt:260-268)': async () => {
    quote(CTRL, 260, 'val sleepAt = sleepUntilSpine')
    quote(CTRL, 261, 'store[cursor].spine >= sleepAt')
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true, untilSpine: 5 })
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: true, atChapterEnd: true })
    w.sentenceDone(4)
    await w.flush()
    assert.deepStrictEqual(pauses(w), [], 'the same section keeps reading')
    w.sentenceDone(5)
    await w.flush()
    assert.deepStrictEqual(pauses(w), ['pause:sleep'])
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false })
    w.sentenceDone(6)
    await w.flush()
    assert.deepStrictEqual(pauses(w), ['pause:sleep'], 'once only: the sleep is cleared')
  },

  'end of chapter with no untilSpine: the section after the current sentence (TtsService.kt:224)': async () => {
    quote(SVC, 224, 'controller.currentSentence?.spine?.plus(1)')
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true, currentSpine: 3 })
    assert.strictEqual(w.tts.state().untilSpine, 4)
    w.sentenceDone(null)
    await w.flush()
    assert.deepStrictEqual(pauses(w), [], 'no next sentence: nothing')
  },

  'end of chapter with no current sentence and no untilSpine: refused (not running)': async () => {
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true })
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: true })
  },

  'the end of the book is an Int in Kotlin (TtsService.kt:225 coerceAtMost): clamped': async () => {
    quote(PLUG, 219, 'coerceAtMost(Int.MAX_VALUE.toLong())')
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true, untilSpine: Number.MAX_SAFE_INTEGER })
    assert.strictEqual(w.tts.state().untilSpine, INT_MAX)
  },

  'adjust +5 min adds to the remaining time (TtsService.kt:228-232)': async () => {
    quote(SVC, 230, 'coerceAtLeast(1000)')
    const w = world()
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    await w.advance(10000)
    await w.serve('increase', { target: 'tts', ms: 300000 })
    assert.deepStrictEqual(last(w).data, { remainingMs: 350000, running: true, atChapterEnd: false })
    await w.advance(349999)
    assert.deepStrictEqual(pauses(w), [])
    await w.advance(1)
    assert.deepStrictEqual(pauses(w), ['pause:sleep'])
  },

  'decrease never goes below one second (coerceAtLeast 1000)': async () => {
    const w = world()
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    await w.serve('decrease', { target: 'tts', ms: 300000 })
    assert.deepStrictEqual(last(w).data, { remainingMs: MIN_REMAINING_MS, running: true, atChapterEnd: false })
  },

  'adjust with no fixed timer running does nothing (TtsService.kt:229 sleepEndsAt 0)': async () => {
    quote(SVC, 228, 'fun adjustSleepTimer(deltaMs: Long) {')
    const w = world()
    const before = w.emits.length
    assert.deepStrictEqual(await w.serve('increase', { target: 'tts', ms: 300000 }), { ok: true })
    assert.strictEqual(w.emits.length, before)
  },

  'cancel stops the timer and tells the UI, even when nothing ran (TtsService.kt:234-238)': async () => {
    quote(SVC, 234, 'fun cancelSleepTimer(notify: Boolean = true) {')
    const w = world()
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    await w.serve('cancel', { target: 'tts' })
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false })
    await w.advance(120000)
    assert.deepStrictEqual(pauses(w), [], 'the cancelled timer does not pause')
    await w.serve('cancel', { target: 'tts' })
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false }, 'cancel always notifies')
  },

  // utils/tts/ttsSession.js listens for this exact name (Capacitor.onCore) to show the read-aloud sleep timer
  'the sleep state reaches the UI as the ttsSleepTimer event that ttsSession listens for': async () => {
    const w = world()
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    assert.strictEqual(last(w).event, 'ttsSleepTimer')
    await w.serve('cancel', { target: 'tts' })
    assert.strictEqual(last(w).event, 'ttsSleepTimer')
  },

  'a fixed timer clears a chapter sleep, and a chapter sleep clears the fixed timer (cancelSleepTimer notify=false)': async () => {
    quote(SVC, 215, 'cancelSleepTimer(notify = false)')
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true, untilSpine: 2 })
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    assert.strictEqual(w.tts.state().untilSpine, null)
    w.sentenceDone(9)
    await w.flush()
    assert.deepStrictEqual(pauses(w), [], 'the chapter sleep no longer pauses')
    await w.serve('set', { target: 'tts', isChapterTime: true, untilSpine: 2 })
    await w.advance(120000)
    assert.deepStrictEqual(pauses(w), [], 'the fixed timer no longer fires')
  },

  'reset clears a chapter sleep and tells the UI, not a fixed timer (TtsController.kt:465-470)': async () => {
    quote(CTRL, 465, 'if (sleepUntilSpine != null) {')
    const w = world()
    await w.serve('set', { target: 'tts', isChapterTime: true, untilSpine: 4 })
    w.reset()
    await w.flush()
    assert.strictEqual(w.tts.state().untilSpine, null)
    assert.deepStrictEqual(last(w).data, { remainingMs: 0, running: false, atChapterEnd: false })
    const n = w.emits.length
    w.reset()
    await w.flush()
    assert.strictEqual(w.emits.length, n, 'no chapter sleep: no event')
    await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false })
    w.reset()
    await w.flush()
    await w.advance(60000)
    assert.deepStrictEqual(pauses(w), ['pause:sleep'], 'the fixed timer still pauses after a reset')
  },

  'switch off: the call answers off and nothing runs': async () => {
    const w = world({ coreTts: false })
    assert.deepStrictEqual(await w.serve('set', { target: 'tts', ms: 60000, isChapterTime: false }), { ok: false, off: true })
    w.sentenceDone(3)
    w.reset()
    await w.advance(120000)
    assert.deepStrictEqual(w.calls.filter((c) => c.startsWith('pause') || c.startsWith('timer')), [])
  },

  'sleep.* with target tts is not gated by coreSleep, and without target still is (coreSleep off, coreTts on)': async () => {
    const w = world({ coreTts: true, coreSleep: false })
    assert.deepStrictEqual(await w.serve('set', { target: 'tts', ms: 30000, isChapterTime: false }), { ok: true })
    assert.deepStrictEqual(await w.serve('set', { ms: 30000, isChapterTime: false }), { ok: false, off: true })
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
console.log(`tts: ${passed} ok${failed ? ', ' + failed + ' failed' : ''}`)
if (failed) process.exit(1)
