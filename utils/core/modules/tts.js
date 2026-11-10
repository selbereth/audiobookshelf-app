/**
 * The TTS (EPUB read-aloud) sleep timer (Phase 10, slice B). Ported from android/app/src/main/java/com/audiobookshelf/app/tts/TtsService.kt
 * (the sleep timer, lines 207-237, and its runnable, 208-212) and TtsController.kt (the end-of-chapter pause in onDone, 251-270,
 * and the reset that clears it, 455-471). Every rule names its Kotlin source (file:line).
 *
 * The sentence store, the engine queue and the cursor stay in native for now (inventory: audiobookshelf-core-refactor-inventory-cast-tts).
 *
 * It runs only while the switch `system.flags` {coreTts} is on (start() reads it, default off). While it is off the Kotlin
 * TtsService timer does everything, as before. While it is on the Kotlin timer is silent (the native side forwards every
 * sleep call here), so only one timer ever pauses the read-aloud.
 *
 * It is reached through the sleep entry point: `sleep.set|increase|decrease|cancel` with `target: 'tts'` is routed here by
 * sleep.js (the core sleep timer drives the TTS player too), and it is gated by coreTts, not coreSleep.
 *
 * Native connectors used:
 *   tts.pause {reason}                 pause the read-aloud (reason 'sleep', as Kotlin)
 *   tick (through tick.js)              one-shot expiry, id 'ttsSleep'
 *   system.flags                        the switch
 * Events in: tts/sentenceDone {nextSpine}  the sentence that just finished; nextSpine is the spine of the next one (null: none)
 *            tts/reset                     the stream was reset (Kotlin reset(): clears a chapter sleep, not a fixed one)
 * Events to the UI (ui.emit): ttsSleepTimer {remainingMs, running, atChapterEnd}, the same shape as the Kotlin onSleepTimer.
 *
 * Differences from the Kotlin, kept on purpose, and listed in the vault questions note:
 *  - the expiry runs on the core's tick, not postDelayed on the main thread; the time is the core's clock.
 *  - the end-of-chapter pause is decided in the core after the native sentenceDone event arrives, so the next sentence may
 *    already have started (Kotlin pauses inside onDone, before it is spoken). Measured on the emulator, see the notes.
 *  - a native call that fails is logged and skipped.
 */

export const TICK_ID = 'ttsSleep'
export const INT_MAX = 2147483647 // TtsController.kt:216-222 untilSpine is an Int; JS sends MAX_SAFE_INTEGER for the end of the book
export const MIN_REMAINING_MS = 1000 // TtsService.kt:229 adjust: coerceAtLeast(1000)

const msOf = (v) => Math.round(Number(v) || 0)

export function ttsModule(bridge, { tick, now = () => Date.now(), log = () => {}, emitToUi = () => {} } = {}) {
  // Kotlin fields: sleepEndsAt (TtsService.kt:207), controller.sleepUntilSpine (TtsController.kt:69)
  const S = { endMs: 0, untilSpine: null }
  let gate = Promise.resolve(false) // the switch, read once by start()
  let queue = Promise.resolve() // every rule runs here, one after the other, like Kotlin's main thread

  const run = (fn) => {
    const p = queue.then(() => gate).then((on) => (on ? fn() : OFF))
    queue = p.then(
      () => {},
      (e) => log('tts: ' + (e && e.message))
    )
    return p
  }
  const later = (fn) => {
    run(fn).catch((e) => log('tts: ' + (e && e.message)))
  }
  const OFF = Object.freeze({ off: true })

  const native = (connector, method, args = {}) =>
    bridge.call(connector, method, args).catch((e) => {
      log(`tts: ${connector}.${method} failed: ${e && e.message}`)
      return undefined
    })
  const pause = () => native('tts', 'pause', { reason: 'sleep' }) // TtsService.kt:210 controller.pause("sleep")
  const emitState = (remainingMs, running, atChapterEnd) =>
    emitToUi('ttsSleepTimer', { remainingMs, running, atChapterEnd }) // TtsService.kt:140-142 onSleepTimer

  /** TtsService.kt:207-212 the runnable: sleepEndsAt = 0, pause, onSleepTimer(0, false, false) */
  async function expire() {
    await tick.stop(TICK_ID)
    S.endMs = 0
    await pause()
    emitState(0, false, false)
  }

  /** TtsService.kt:236-237 cancelSleepTimer: remove the runnable, clear the end time and the chapter pause */
  async function clear() {
    await tick.stop(TICK_ID)
    S.endMs = 0
    S.untilSpine = null // TtsService.kt:235 controller.sleepUntilSpine = null
  }

  /** TtsService.kt:214-218 setSleepTimer(ms). A chapter sleep is cleared first (cancelSleepTimer(notify = false) at :215). */
  async function setTimer(ms) {
    await clear()
    const len = Math.max(0, msOf(ms))
    S.endMs = now() + len // :216 sleepEndsAt = elapsed + ms
    emitState(len, true, false) // :219 onSleepTimer(ms, true, false), before the runnable can run
    if (len === 0) {
      // postDelayed(0) runs the runnable next: the same here, without a timer
      await expire()
    } else {
      const started = await tick.start(TICK_ID, { everyMs: len, onTick: () => later(expire) })
      if (started && started.error) log('tts: the sleep tick could not be scheduled: ' + started.error)
    }
    return true
  }

  /** TtsService.kt:222-226 setSleepAtChapterEnd(untilSpine); null = the spine after the current sentence (:224) */
  async function setChapterEnd(untilSpine, currentSpine) {
    await clear()
    let until = untilSpine === null || untilSpine === undefined ? (currentSpine == null ? null : currentSpine + 1) : untilSpine
    if (until !== null) until = Math.min(until, INT_MAX) // TtsService.kt:225 coerceAtMost(Int.MAX_VALUE)
    S.untilSpine = until
    emitState(0, until !== null, true) // :225-226 onSleepTimer(0, untilSpine != null, true)
    return true
  }

  /** TtsService.kt:228-232 adjustSleepTimer(delta): nothing when no fixed timer runs; else the remaining time plus delta, at least 1 s */
  async function adjust(deltaMs) {
    if (S.endMs === 0) return true
    const remaining = Math.max(S.endMs - now() + msOf(deltaMs), MIN_REMAINING_MS)
    return setTimer(remaining)
  }

  /** TtsService.kt:234-238 cancelSleepTimer(notify = true) */
  async function cancel() {
    await clear()
    emitState(0, false, false)
    return true
  }

  /** TtsController.kt:260-268 in onDone: the next sentence is in a later section than the sleep chapter: pause */
  async function onSentenceDone(nextSpine) {
    const at = S.untilSpine
    if (at === null || nextSpine === null || nextSpine === undefined) return // :259 cursor < store.size
    if (nextSpine < at) return // :264 store[cursor].spine >= sleepAt
    S.untilSpine = null // :262
    await pause() // :267 pause("sleep")
    emitState(0, false, false) // :268 onSleepTimer(0, false, false)
  }

  /** TtsController.kt:465-470 reset(): a chapter sleep is cleared (and told to the UI); a fixed timer is not touched */
  async function onReset() {
    if (S.untilSpine === null) return
    S.untilSpine = null
    emitState(0, false, false)
  }

  /**
   * Serves a sleep call from sleep.js with target 'tts'. method: set {ms, isChapterTime, untilSpine, currentSpine} (ms 0 with
   * isChapterTime = the end of the chapter), increase {ms}, decrease {ms}, cancel.
   * Answers {ok} or {ok: false, off: true} while the switch is off.
   */
  async function sleep(method, args = {}) {
    const r = await run(async () => {
      if (method === 'set') {
        if (args.isChapterTime) return { ok: await setChapterEnd(args.untilSpine ?? null, args.currentSpine ?? null) }
        return { ok: await setTimer(args.ms) }
      }
      if (method === 'increase') return { ok: await adjust(msOf(args.ms)) }
      if (method === 'decrease') return { ok: await adjust(-msOf(args.ms)) }
      if (method === 'cancel') return { ok: await cancel() }
      return { ok: false, error: 'unknown tts sleep method ' + method }
    })
    return r === OFF ? { ok: false, off: true } : r
  }

  function start() {
    gate = bridge.call('system', 'flags', {}).then(
      (f) => f?.coreTts === true,
      (e) => {
        log('tts: the switch could not be read, the core TTS sleep stays off: ' + (e && e.message))
        return false
      }
    )
    bridge.on('tts', 'sentenceDone', (d) => later(() => onSentenceDone(d.nextSpine ?? null)))
    bridge.on('tts', 'reset', () => later(onReset))
  }

  return {
    start,
    sleep,
    /** For the tests and the diagnostics */
    state: () => ({ ...S }),
    /** Tests: the expiry and the chapter pause without a native event */
    expireNow: () => run(expire),
    sentenceDone: (nextSpine) => run(() => onSentenceDone(nextSpine))
  }
}
