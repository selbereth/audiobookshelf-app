/**
 * Core timers (Phase 4b). The core names every time: native only fires a callback at the time it is given (the `timer`
 * connector) and reports it back as the event `timer/tick {id, atMs}`. This module keeps the timers the core started, asks
 * native for the next tick after each one, and drops a tick the core no longer wants (stopped, or left over from before a
 * core restart). What a tick means is the caller's decision, not this module's.
 *
 *   tick.start(id, { everyMs, onTick })  first tick at now + everyMs; onTick({atMs, t}): atMs = the time the core asked for,
 *                                        t = the time native fired it. Answers {ok} or {error} (native refused to schedule).
 *   tick.stop(id)                        no more ticks; a tick already on its way is ignored. Answers {ok}.
 *   tick.isRunning(id)
 *
 * A tick that is a period or more late does not produce a burst: the next one is one period after now.
 */
export function tickModule(bridge, { now = () => Date.now() } = {}) {
  const timers = new Map() // id -> { everyMs, onTick, dueMs }

  const schedule = (id, atMs) => bridge.call('timer', 'schedule', { id, atMs })

  function start(id, { everyMs, onTick } = {}) {
    if (!(everyMs > 0) || typeof onTick !== 'function') throw new Error('tick.start needs everyMs > 0 and onTick')
    const timer = { everyMs, onTick, dueMs: now() + everyMs }
    timers.set(id, timer)
    return schedule(id, timer.dueMs).then(
      () => ({ ok: true }),
      (e) => {
        if (timers.get(id) === timer) timers.delete(id)
        return { error: e.message || 'timer refused' }
      }
    )
  }

  function stop(id) {
    if (!timers.delete(id)) return Promise.resolve({ ok: true })
    return bridge.call('timer', 'cancel', { id }).then(() => ({ ok: true }), (e) => ({ error: e.message || 'cancel failed' }))
  }

  bridge.on('timer', 'tick', (data, t) => {
    const timer = timers.get(data.id)
    // Not running, or a tick for an earlier start of the same id (its due time differs): ignored
    if (!timer || timer.dueMs !== data.atMs) return
    let next = timer.dueMs + timer.everyMs
    if (next <= now()) next = now() + timer.everyMs
    timer.dueMs = next
    const id = data.id
    schedule(id, next).catch(() => {
      if (timers.get(id) === timer) timers.delete(id)
    })
    timer.onTick({ atMs: data.atMs, t })
  })

  return { start, stop, isRunning: (id) => timers.has(id) }
}
