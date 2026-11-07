import assert from 'assert'
import { execSync } from 'child_process'
import { tickModule } from './modules/tick'
import { sleepModule, chapterEndTimeFor, remainingSecOf, totalDurationMs } from './modules/sleep'

// Every test quotes the Kotlin line it ports. `quote` reads that line from the Kotlin source and checks the needle is on it,
// so a quoted line that drifts from the source fails the test.
// The Kotlin the rules were ported from: the master commit (the Kotlin edits of this phase move the line numbers)
const ROOT = process.cwd()
const MASTER = '2db72b09'
const SRC = {
  timer: 'android/app/src/main/java/com/audiobookshelf/app/managers/SleepTimerManager.kt',
  pns: 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerNotificationService.kt',
  syncer: 'android/app/src/main/java/com/audiobookshelf/app/media/MediaProgressSyncer.kt',
  listener: 'android/app/src/main/java/com/audiobookshelf/app/player/PlayerListener.kt',
  session: 'android/app/src/main/java/com/audiobookshelf/app/data/PlaybackSession.kt'
}
const lines = {}
function quote(file, line, needle) {
  if (!lines[file]) lines[file] = execSync(`git show ${MASTER}:${SRC[file]}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = lines[file][line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${file}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}

const MIN = 60000
const H = (h, m) => new Date(2026, 10, 6, h, m, 0, 0).getTime() // local wall time, as the Kotlin Calendar uses

// Fake native: the player (position moves while playing), the connectors the rules call, and the timer that tick.js uses.
function world({ settings = {}, session = null, positionSec = 0, playing = false, rate = 1, coreSleep = true, t0 = H(12, 0) } = {}) {
  const clock = { t: t0 }
  const calls = []
  const handlers = new Map()
  const servers = new Map()
  const timers = new Map() // id -> due ms
  const emits = []
  const player = { playing, rate, base: positionSec, since: t0 }
  const pos = () => (player.playing ? player.base + ((clock.t - player.since) / 1000) * player.rate : player.base)
  const freeze = () => { player.base = pos(); player.since = clock.t }
  const dev = { ...settings }
  const native = (connector, method, args) => {
    calls.push({ connector, method, args, t: clock.t })
    if (connector === 'system' && method === 'flags') return Promise.resolve({ coreSleep })
    if (connector === 'timer') {
      if (method === 'schedule') timers.set(args.id, args.atMs)
      if (method === 'cancel') timers.delete(args.id)
      return Promise.resolve({})
    }
    if (connector === 'ui' && method === 'emit') {
      emits.push({ event: args.event, data: args.data })
      return Promise.resolve({ delivered: true })
    }
    if (connector === 'player') {
      if (method === 'getPosition') return Promise.resolve({ live: !!session, playing: player.playing, positionSec: pos(), rate: player.rate, sessionId: session ? session.id : null, atMs: clock.t })
      if (method === 'getState') return Promise.resolve({ live: !!session, playing: player.playing, positionSec: pos(), rate: player.rate, sessionId: session ? session.id : null, session })
      if (method === 'pause') { freeze(); player.playing = false; return Promise.resolve({}) }
      if (method === 'play') { freeze(); player.playing = true; return Promise.resolve({}) }
      if (method === 'setVolume') return Promise.resolve({})
      if (method === 'seekBackward') { freeze(); player.base -= args.ms / 1000; return Promise.resolve({}) }
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
  const db = { methods: { getDeviceData: async () => ({ deviceSettings: dev }) } }
  const sleep = sleepModule(bridge, { tick, db, now: () => clock.t, log: () => {}, emitToUi: (event, data) => native('ui', 'emit', { event, data }) })
  sleep.start()
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }
  // Runs native time forward: fires every timer due on the way, in order, then stops at `ms` from now
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
  const event = async (data, t = clock.t) => {
    for (const h of [...(handlers.get('player/state') || [])]) h(data, t)
    await flush()
  }
  const shake = async () => {
    for (const h of [...(handlers.get('sensor/shake') || [])]) h({}, clock.t)
    await flush()
  }
  const serve = (name, args) => servers.get(name)(args)
  const named = (m) => calls.filter((c) => c.method === m)
  return {
    sleep, tick, clock, calls, emits, timers, player, dev, handlers, servers, serve, named, advance, event, shake, flush,
    play: async () => { freeze(); player.playing = true; await event({ reason: 'playing', sessionId: session ? session.id : null, playing: true }) },
    pause: async () => { freeze(); player.playing = false; await event({ reason: 'paused', sessionId: session ? session.id : null, playing: false }) },
    set: async (ms, extra = {}) => {
      const r = await serve('sleep/set', { ms, isChapterTime: false, sessionId: 'ps1', ...extra })
      await flush()
      return r
    },
    lastEmit: () => emits[emits.length - 1]
  }
}

// A book: 3 chapters, 1 track of 1200 s. Chapters: 0-300, 300-600, 600-900; 900-1200 is the last (no chapter gap).
const CHAPTERS = [
  { id: 1, start: 0, end: 300, title: 'one' },
  { id: 2, start: 300, end: 600, title: 'two' },
  { id: 3, start: 600, end: 900, title: 'three' }
]
const session = (extra = {}) => ({
  id: 'ps1',
  currentTime: 0,
  chapters: CHAPTERS,
  audioTracks: [{ index: 1, startOffset: 0, duration: 1200 }],
  ...extra
})

const tests = {
  // ---- the pure rules
  'remaining seconds: fixed timer, integer division of ms first (SleepTimerManager.kt:89)'() {
    quote('timer', 89, 'roundToInt()')
    assert.strictEqual(remainingSecOf({ endMs: 0, lengthMs: 60000, elapsedMs: 1500 }, 1, 0), 58) // (60000-1500)/1000 = 58.5 -> trunc 58
    assert.strictEqual(remainingSecOf({ endMs: 0, lengthMs: 60000, elapsedMs: 1000 }, 1, 0), 59)
  },
  'remaining seconds: chapter end divided by the speed (SleepTimerManager.kt:93)'() {
    quote('timer', 93, 'toDouble() / speed')
    assert.strictEqual(remainingSecOf({ endMs: 600000, lengthMs: 0, elapsedMs: 0 }, 1, 100000), 500)
    assert.strictEqual(remainingSecOf({ endMs: 600000, lengthMs: 0, elapsedMs: 0 }, 2, 100000), 250)
    assert.strictEqual(remainingSecOf({ endMs: 0, lengthMs: 0, elapsedMs: 0 }, 1, 0), 0) // :92 no end time
  },
  'chapter end: the current chapter end (SleepTimerManager.kt:316, PlayerNotificationService.kt:840-841)'() {
    quote('timer', 316, 'currentChapterEndTimeMs')
    assert.strictEqual(chapterEndTimeFor(session(), 100000), 300000)
  },
  'chapter end: less than 10 s left uses the next chapter (SleepTimerManager.kt:303-313)'() {
    quote('timer', 303, 'timeLeftInChapter < 10000L')
    assert.strictEqual(chapterEndTimeFor(session(), 295000), 600000) // 5 s left in chapter 1: chapter 2 ends at 600
  },
  'chapter end: exactly 10 s left keeps the current chapter (SleepTimerManager.kt:303, strict <)'() {
    quote('timer', 303, '< 10000L')
    assert.strictEqual(chapterEndTimeFor(session(), 290000), 300000)
  },
  'chapter end: no next chapter gives null (SleepTimerManager.kt:306-310)'() {
    quote('timer', 306, 'nextChapterEndTimeMs == null')
    const s = session({ chapters: [{ id: 1, start: 0, end: 300 }] }) // only one chapter, last track end is 1200 s
    s.audioTracks = [{ index: 1, startOffset: 0, duration: 300 }]
    assert.strictEqual(chapterEndTimeFor(s, 295000), null)
  },
  'chapter end: no session gives null (SleepTimerManager.kt:294-296)'() {
    quote('timer', 294, 'if (currentChapterEndTimeMs == null)')
    assert.strictEqual(chapterEndTimeFor(null, 0), null)
  },
  'duration: sum of the tracks in ms (PlaybackSession.kt:150-155, :72-73)'() {
    quote('session', 150, 'fun getTotalDuration')
    assert.strictEqual(totalDurationMs(session({ audioTracks: [{ startOffset: 0, duration: 100.5 }, { startOffset: 100.5, duration: 50 }] })), 150500)
    assert.strictEqual(totalDurationMs(null), 0)
  },

  // ---- the timer's life cycle, with native time
  async 'set: fixed timer registers the shake sensor, emits the countdown, starts the 1 s tick (SleepTimerManager.kt:101-145)'() {
    quote('timer', 137, 'playerNotificationService.registerSensor()')
    quote('timer', 144, 'sleepTimerTask =')
    const w = world({ session: session() })
    assert.deepStrictEqual(await w.set(600000), { ok: true })
    assert.strictEqual(w.named('register').length, 1)
    assert.deepStrictEqual(w.lastEmit(), { event: 'sleepTimerSet', data: { value: 600, isAuto: false } }) // :139-142
    assert.ok(w.timers.has('sleep'))
    assert.strictEqual(w.timers.get('sleep'), w.clock.t + 1000) // :145 period 1000
  },
  async 'countdown: only while playing (SleepTimerManager.kt:147 if (getIsPlaying()))'() {
    quote('timer', 147, 'if (getIsPlaying())')
    const w = world({ session: session() })
    await w.set(60000)
    await w.advance(5000)
    assert.strictEqual(w.lastEmit().data.value, 60) // not playing: no elapsed time
    await w.play()
    await w.advance(10000)
    assert.strictEqual(w.lastEmit().data.value, 50)
  },
  async 'countdown: one emit per playing second, the value falls by one (SleepTimerManager.kt:157-161)'() {
    quote('timer', 158, 'onSleepTimerSet(')
    const w = world({ session: session() })
    await w.set(5000)
    await w.play()
    await w.advance(3000)
    const vals = w.emits.filter((e) => e.event === 'sleepTimerSet').map((e) => e.data.value)
    assert.deepStrictEqual(vals, [5, 4, 3, 2]) // set emits 5; the tick at once (playing) emits 4; then one a second
    assert.strictEqual(w.lastEmit().data.value, 2)
  },
  async 'end: at 0 pauses once, emits the position in ms, clears and records when it finished (SleepTimerManager.kt:168-176)'() {
    quote('timer', 170, 'pause()')
    quote('timer', 172, 'onSleepTimerEnded(')
    quote('timer', 176, 'sleepTimerFinishedAt = System.currentTimeMillis()')
    const w = world({ session: session() })
    await w.set(3000)
    await w.play()
    await w.advance(4000)
    const pauses = w.named('pause')
    assert.strictEqual(pauses.length, 1)
    const ended = w.emits.filter((e) => e.event === 'sleepTimerEnded')
    assert.strictEqual(ended.length, 1)
    assert.strictEqual(ended[0].data.value, 3000)
    assert.strictEqual(w.sleep.state().running, false)
    assert.ok(w.sleep.state().finishedAt > 0)
  },
  async 'end: no second pause after the timer has finished (the tick is stopped, SleepTimerManager.kt:220)'() {
    quote('timer', 220, 'sleepTimerTask?.cancel()')
    const w = world({ session: session() })
    await w.set(2000)
    await w.play()
    await w.advance(2000)
    await w.advance(20000) // no shake, no play: nothing starts again
    assert.strictEqual(w.named('pause').length, 1)
    assert.strictEqual(w.timers.has('sleep'), false)
  },
  async 'fade: from 60 s to 0 the volume goes down to 10% (SleepTimerManager.kt:177-189)'() {
    quote('timer', 183, 'val percentToReduce = 1 - (sleepTimeSecondsRemaining / 60F)')
    quote('timer', 184, 'val volume = 1f - (percentToReduce * 0.9f)')
    const w = world({ session: session() })
    await w.set(30000)
    await w.play()
    await w.advance(10000) // remaining 20 s: percent 2/3, volume 1 - 2/3 * 0.9 = 0.4
    const vols = w.calls.filter((c) => c.method === 'setVolume').map((c) => c.args.volume)
    const last = vols[vols.length - 1]
    assert.ok(Math.abs(last - 0.4) < 1e-9, 'volume ' + last)
  },
  async 'fade: disabled in settings keeps the volume at 1 (SleepTimerManager.kt:177-181, :190-191)'() {
    quote('timer', 180, 'disableSleepTimerFadeOut != true')
    const w = world({ session: session(), settings: { disableSleepTimerFadeOut: true } })
    await w.set(30000)
    await w.play()
    await w.advance(10000)
    const vols = w.calls.filter((c) => c.method === 'setVolume').map((c) => c.args.volume)
    assert.ok(vols.every((v) => v === 1))
  },
  async 'almost done chime: at 30 s remaining, only when enabled (SleepTimerManager.kt:164-166)'() {
    quote('timer', 164, 'enableSleepTimerAlmostDoneChime == true')
    const off = world({ session: session() })
    await off.set(40000)
    await off.play()
    await off.advance(15000)
    assert.strictEqual(off.named('chime').length, 0)
    const on = world({ session: session(), settings: { enableSleepTimerAlmostDoneChime: true } })
    await on.set(40000)
    await on.play()
    await on.advance(15000)
    assert.strictEqual(on.named('chime').length, 1)
    assert.strictEqual(on.named('chime')[0].args.volume, 0.7)
  },

  // ---- chapter end, increase / decrease
  async 'chapter timer: time 0 uses the end of the chapter; countdown is the distance to it (SleepTimerManager.kt:109-130)'() {
    quote('timer', 109, 'if (time == 0L)')
    const w = world({ session: session(), positionSec: 100 })
    assert.deepStrictEqual(await w.set(0, { isChapterTime: true }), { ok: true })
    assert.strictEqual(w.lastEmit().data.value, 200) // 300 - 100
  },
  async 'chapter timer: refused when there is no session (SleepTimerManager.kt:113-116)'() {
    quote('timer', 113, 'if (chapterEndTime == null)')
    const w = world({ session: null })
    assert.deepStrictEqual(await w.set(0, { isChapterTime: true }), { ok: false })
    assert.strictEqual(w.sleep.state().running, true, 'Kotlin sets running before the check (:104) and does not reset it')
  },
  async 'chapter timer: the end is clamped to the duration (SleepTimerManager.kt:126-128)'() {
    quote('timer', 127, 'sleepTimerEndTime = getDuration()')
    const s = session({ chapters: [{ id: 1, start: 0, end: 2000 }], audioTracks: [{ index: 1, startOffset: 0, duration: 1200 }] })
    const w = world({ session: s, positionSec: 100 })
    await w.set(0, { isChapterTime: true })
    assert.strictEqual(w.lastEmit().data.value, 1100) // clamped to 1200 s, not 2000 s
  },
  async 'increase: fixed timer adds time, capped at the time left in the book (SleepTimerManager.kt:404-405)'() {
    quote('timer', 405, 'sleepTimerLength = minOf(sleepTimerLength, getDuration() - getCurrentTime())')
    const w = world({ session: session(), positionSec: 1000 })
    await w.set(60000)
    await w.serve('sleep/increase', { ms: 300000 })
    assert.strictEqual(w.lastEmit().data.value, 200) // capped: 1200 - 1000 = 200 s
  },
  async 'increase: chapter end moves by time times speed, capped at the duration (SleepTimerManager.kt:408-409)'() {
    quote('timer', 409, 'minOf(sleepTimerEndTime + (time * getPlaybackSpeed()).roundToInt(), getDuration())')
    const w = world({ session: session(), positionSec: 100, rate: 2 })
    await w.set(0, { isChapterTime: true }) // end 300 s
    await w.serve('sleep/increase', { ms: 60000 }) // +60 s at 2x = +120 s -> end 420 s, 320 s away at 2x -> 160
    assert.strictEqual(w.lastEmit().data.value, 160)
  },
  async 'decrease: fixed timer never goes under 1 s (SleepTimerManager.kt:431)'() {
    quote('timer', 431, 'maxOf(sleepTimerLength - time, 1000L)')
    const w = world({ session: session() })
    await w.set(10000)
    await w.serve('sleep/decrease', { ms: 300000 })
    assert.strictEqual(w.lastEmit().data.value, 1)
  },
  async 'decrease: chapter end never goes under 1 s after the position (SleepTimerManager.kt:437)'() {
    quote('timer', 437, 'getCurrentTime() + 1000')
    const w = world({ session: session(), positionSec: 100 })
    await w.set(0, { isChapterTime: true })
    await w.serve('sleep/decrease', { ms: 600000 })
    assert.strictEqual(w.lastEmit().data.value, 1)
  },
  async 'increase and decrease do nothing when no timer runs (SleepTimerManager.kt:398, :425)'() {
    quote('timer', 398, 'if (!sleepTimerRunning) return')
    const w = world({ session: session() })
    await w.serve('sleep/increase', { ms: 60000 })
    assert.strictEqual(w.emits.length, 0)
  },

  // ---- cancel, shake, grace period, auto rewind
  async 'cancel: emits 0 and unregisters the sensor only after the 2 min window (SleepTimerManager.kt:238-248, PlayerNotificationService.kt:2086-2088)'() {
    quote('timer', 247, 'onSleepTimerSet(0, false)')
    quote('pns', 2087, 'shakeSensorUnregisterTask =')
    const w = world({ session: session() })
    await w.set(60000)
    await w.serve('sleep/cancel', {})
    assert.deepStrictEqual(w.lastEmit(), { event: 'sleepTimerSet', data: { value: 0, isAuto: false } })
    assert.strictEqual(w.named('unregister').length, 0)
    await w.advance(119000)
    assert.strictEqual(w.named('unregister').length, 0)
    await w.advance(2000)
    assert.strictEqual(w.named('unregister').length, 1)
  },
  async 'shake: during a running timer that has run more than 3 s, it resets and plays (SleepTimerManager.kt:341-345, :382-388)'() {
    quote('timer', 341, 'if (sleepTimerLength == 0L || sleepTimerElapsed > 3000L)')
    quote('timer', 383, 'if ((sleepTimerRunning && getIsPlaying()) || sleepTimerFinishedAt > 0L)')
    const w = world({ session: session() })
    await w.set(60000)
    await w.play()
    await w.advance(2000)
    await w.shake()
    assert.strictEqual(w.named('play').length, 0, 'within 3 s: no reset')
    await w.advance(3000)
    await w.shake()
    assert.strictEqual(w.named('play').length, 1)
    assert.strictEqual(w.named('vibrate').length, 1)
    assert.strictEqual(w.lastEmit().data.value, 59) // reset emits 60, the tick at once (playing) emits 59
  },
  async 'shake: ignored when the setting disables it (SleepTimerManager.kt:384-387)'() {
    quote('timer', 384, 'disableShakeToResetSleepTimer == true')
    const w = world({ session: session(), settings: { disableShakeToResetSleepTimer: true } })
    await w.set(60000)
    await w.play()
    await w.advance(10000)
    await w.shake()
    assert.strictEqual(w.named('vibrate').length, 0)
  },
  async 'shake: no vibration when the reset feedback is disabled (SleepTimerManager.kt:252)'() {
    quote('timer', 252, 'disableSleepTimerResetFeedback == true')
    const w = world({ session: session(), settings: { disableSleepTimerResetFeedback: true } })
    await w.set(60000)
    await w.play()
    await w.advance(5000)
    await w.shake()
    assert.strictEqual(w.named('play').length, 1)
    assert.strictEqual(w.named('vibrate').length, 0)
  },
  async 'grace: after the timer ended, a shake within 2 min starts it again (SleepTimerManager.kt:352-374)'() {
    quote('timer', 352, 'if (finishedAtDistance > SLEEP_TIMER_WAKE_UP_EXPIRATION)')
    const w = world({ session: session() })
    await w.set(2000)
    await w.play()
    await w.advance(3000) // ended
    await w.advance(60000) // 60 s later
    await w.shake()
    assert.strictEqual(w.named('play').length, 1)
    assert.ok(w.sleep.state().running)
  },
  async 'grace: after 2 min the shake does nothing (SleepTimerManager.kt:352-357)'() {
    quote('timer', 355, 'sleepTimerFinishedAt = 0L')
    const w = world({ session: session() })
    await w.set(2000)
    await w.play()
    await w.advance(3000)
    await w.advance(121000)
    await w.shake()
    assert.strictEqual(w.named('play').length, 0)
    assert.strictEqual(w.sleep.state().finishedAt, 0)
  },
  async 'grace: a 1 s timer that ended is not started again by a shake (SleepTimerManager.kt:361-365)'() {
    quote('timer', 361, 'if (sleepTimerLength == 1000L)')
    const w = world({ session: session() })
    await w.set(1000)
    await w.play()
    await w.advance(1000) // ends at the first playing second
    assert.strictEqual(w.named('pause').length, 1)
    await w.shake()
    assert.strictEqual(w.named('play').length, 0)
    assert.strictEqual(w.sleep.state().running, false)
  },
  async 'auto rewind: on a restart after the timer ended, the book goes back the setting time (SleepTimerManager.kt:324-334)'() {
    quote('timer', 326, 'if (isAutoSleepTimer && deviceSettings.autoSleepTimerAutoRewind)')
    quote('timer', 331, 'playerNotificationService.seekBackward(deviceSettings.autoSleepTimerAutoRewindTime)')
    const w = world({ session: session(), positionSec: 500, settings: { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 2000, autoSleepTimerAutoRewind: true, autoSleepTimerAutoRewindTime: 300000 }, t0: H(23, 0) })
    await w.event({ reason: 'playing', sessionId: 'ps1' }) // auto timer starts (isAuto true), first auto rewind does not happen
    assert.strictEqual(w.named('seekBackward').length, 0)
    assert.strictEqual(w.sleep.state().isAuto, true)
    await w.play()
    await w.advance(3000)
    await w.shake()
    assert.strictEqual(w.named('seekBackward').length, 1)
    assert.strictEqual(w.named('seekBackward')[0].args.ms, 300000)
  },

  // ---- the automatic window
  async 'auto: starts inside the window, with the setting length and isAuto (SleepTimerManager.kt:494-506)'() {
    quote('timer', 494, 'if (isDuringAutoTime)')
    quote('timer', 506, 'setSleepTimer(deviceSettings.sleepTimerLength)')
    const w = world({ session: session(), t0: H(23, 0), settings: { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 } })
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().running, true)
    assert.strictEqual(w.sleep.state().isAuto, true)
    assert.strictEqual(w.sleep.state().lengthMs, 900000)
  },
  async 'auto: the window across midnight, at 00:30 the start is the day before (SleepTimerManager.kt:472-474)'() {
    quote('timer', 473, 'if (currentCalendar.before(startCalendar))')
    const w = world({ session: session(), t0: H(0, 30), settings: { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 } })
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().running, true)
  },
  async 'auto: outside the window nothing starts (SleepTimerManager.kt:507-509)'() {
    quote('timer', 507, '} else {')
    const w = world({ session: session(), t0: H(12, 0), settings: { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 } })
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().running, false)
  },
  async 'auto: off in settings nothing starts (SleepTimerManager.kt:454)'() {
    quote('timer', 454, 'if (!deviceSettings.autoSleepTimer) return')
    const w = world({ session: session(), t0: H(23, 0), settings: { autoSleepTimer: false, sleepTimerLength: 900000 } })
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().running, false)
  },
  async 'auto: cancelling inside the window disables it until the window ends (SleepTimerManager.kt:241-244, :484-491)'() {
    quote('timer', 242, 'Log.i(tag, "Disabling auto sleep timer for this time period")')
    quote('timer', 488, 'autoTimerDisabled = false')
    const settings = { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 }
    const w = world({ session: session(), t0: H(23, 0), settings })
    await w.sleep.checkAutoSleepTimer()
    await w.serve('sleep/cancel', {}) // isAuto true: disabled for this period
    assert.strictEqual(w.sleep.state().autoDisabled, true)
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().running, false, 'still in the window: no timer')
    w.clock.t = H(7, 0) // out of the window: re-enabled
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().autoDisabled, false)
  },
  async 'auto: a manual timer is not replaced by the auto check (SleepTimerManager.kt:450-452)'() {
    quote('timer', 450, 'if (sleepTimerRunning)')
    const w = world({ session: session(), t0: H(23, 0), settings: { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 } })
    await w.set(60000)
    await w.sleep.checkAutoSleepTimer()
    assert.strictEqual(w.sleep.state().isAuto, false)
    assert.strictEqual(w.sleep.state().lengthMs, 60000)
  },
  async 'auto: runs every 15 s while playing, stops on pause (MediaProgressSyncer.kt:79-83, :146-151)'() {
    quote('syncer', 79, 'schedule(15000L, 15000L)')
    quote('syncer', 81, 'if (playerNotificationService.currentPlayer.isPlaying)')
    quote('syncer', 83, 'checkAutoSleepTimer()')
    quote('timer', 457, 'startCalendar.set(Calendar.HOUR_OF_DAY, deviceSettings.autoSleepTimerStartHour)')
    quote('syncer', 149, 'listeningTimerTask?.cancel()')
    const settings = { autoSleepTimer: true, autoSleepTimerStartTime: '22:00', autoSleepTimerEndTime: '06:00', sleepTimerLength: 900000 }
    const w = world({ session: session(), t0: H(21, 59), settings })
    await w.event({ reason: 'playing', sessionId: 'ps1' }) // starts the auto check, 21:59 is outside the window
    assert.ok(w.timers.has('sleepAuto'))
    assert.strictEqual(w.sleep.state().running, false)
    w.player.playing = true
    // Kotlin's Calendar.set(HOUR_OF_DAY) and set(MINUTE) keep the current seconds (SleepTimerManager.kt:457-461), so the window
    // starts at 22:00:ss of the check itself and a check at 22:00:ss is not after it: the first check that starts it is 22:01:00
    await w.advance(76000) // ticks 21:59:15 ... 22:00:15
    assert.strictEqual(w.sleep.state().running, false, 'a check in the start minute does not start it (Calendar keeps the seconds)')
    await w.advance(45000) // ticks 22:00:30 ... 22:01:00
    assert.strictEqual(w.sleep.state().running, true)
    await w.event({ reason: 'paused', sessionId: 'ps1' })
    assert.strictEqual(w.timers.has('sleepAuto'), false)
  },

  // ---- events and switch
  async 'playing with a session: the volume is put back to 1 (PlayerListener.kt:106)'() {
    quote('listener', 106, 'player.volume = 1F')
    const w = world({ session: session() })
    await w.event({ reason: 'playing', sessionId: 'ps1' })
    assert.ok(w.named('setVolume').some((c) => c.args.volume === 1))
  },
  async 'playing without a session does nothing (PlayerListener.kt:102)'() {
    quote('listener', 102, 'playbackSession?.let')
    const w = world({ session: null })
    await w.event({ reason: 'playing', sessionId: null })
    assert.strictEqual(w.calls.filter((c) => c.connector === 'player').length, 0)
  },
  async 'playing a different book while the timer runs resets it (SleepTimerManager.kt:523-524)'() {
    quote('timer', 523, 'if (sleepTimerSessionId == playbackSessionId || sleepTimerRunning)')
    const w = world({ session: session() })
    await w.set(60000)
    await w.play()
    await w.advance(10000)
    await w.event({ reason: 'playing', sessionId: 'other' })
    assert.strictEqual(w.named('play').length >= 1, true)
    assert.strictEqual(w.lastEmit().data.value, 59)
  },
  async 'resend: a running timer sends its countdown, none sends 0 (SleepTimerManager.kt:535-543)'() {
    quote('timer', 541, 'onSleepTimerSet(0, false)')
    const w = world({ session: session() })
    await w.serve('sleep/resend', {})
    assert.deepStrictEqual(w.lastEmit().data, { value: 0, isAuto: false })
    await w.set(60000)
    await w.serve('sleep/resend', {})
    assert.strictEqual(w.lastEmit().data.value, 60)
  },
  async 'a new timer restarts the countdown; the old tick is stopped (SleepTimerManager.kt:103)'() {
    quote('timer', 103, 'sleepTimerTask?.cancel()')
    const w = world({ session: session() })
    await w.set(60000)
    await w.set(30000)
    assert.strictEqual(w.lastEmit().data.value, 30)
    assert.strictEqual([...w.timers.keys()].filter((k) => k === 'sleep').length, 1)
  },
  async 'a timer set within 2 min of a cancel: the old unregister still fires (SleepTimerManager.kt:137 + PlayerNotificationService.kt:2066-2070)'() {
    quote('pns', 2066, 'if (isShakeSensorRegistered)')
    const w = world({ session: session() })
    await w.set(60000)
    await w.serve('sleep/cancel', {})
    await w.advance(30000)
    await w.set(600000) // registerSensor returns early while registered: the pending unregister stays
    await w.advance(90000)
    assert.strictEqual(w.named('unregister').length, 1, 'Kotlin keeps this order; a known quirk, kept')
  },
  async 'switch off: the serve answers off and nothing reaches native but the switch read (system.flags, default off)'() {
    quote('timer', 102, 'Log.d(tag, "Setting Sleep Timer for $time")')
    const w = world({ session: session(), coreSleep: false })
    assert.deepStrictEqual(await w.serve('sleep/set', { ms: 60000, isChapterTime: false, sessionId: 'ps1' }), { ok: false, off: true })
    await w.event({ reason: 'playing', sessionId: 'ps1' })
    await w.shake()
    assert.deepStrictEqual(w.calls.map((c) => c.connector + '.' + c.method), ['system.flags'])
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
console.log(`sleep: ${passed} ok${failed ? ', ' + failed + ' failed' : ''}`)
if (failed) process.exit(1)
