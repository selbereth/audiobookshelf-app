import assert from 'assert'
import { tickModule } from './modules/tick'

// Fake native: records the timer calls. `refuse` makes every schedule fail the way a native refusal would;
// `refuseAfter` lets the first n schedules through and refuses the rest.
function setup({ refuse = false, refuseAfter = Infinity } = {}) {
  const calls = []
  const handlers = new Map()
  const clock = { t: 1000 }
  let scheduled = 0
  const bridge = {
    call: (connector, method, args) => {
      calls.push({ connector, method, args })
      if (connector !== 'timer') return Promise.reject(new Error('unexpected ' + connector))
      if (method === 'schedule' && (refuse || ++scheduled > refuseAfter)) return Promise.reject(new Error('timer refused'))
      return Promise.resolve({})
    },
    on: (connector, event, h) => {
      const k = connector + '/' + event
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k).add(h)
      return () => handlers.get(k).delete(h)
    }
  }
  const tick = tickModule(bridge, { now: () => clock.t })
  // Native fires a tick: the event data and the native time it happened
  const fire = (id, atMs, t = atMs) => {
    for (const h of [...(handlers.get('timer/tick') || [])]) h({ id, atMs }, t)
  }
  const schedules = () => calls.filter((c) => c.method === 'schedule')
  const cancels = () => calls.filter((c) => c.method === 'cancel')
  return { tick, calls, fire, clock, schedules, cancels }
}

const tests = {
  async 'normal tick: start asks native for the first tick at now + period, the tick calls back, the next one is one period later'() {
    const t = setup()
    const got = []
    assert.deepStrictEqual(await t.tick.start('progress', { everyMs: 15000, onTick: (x) => got.push(x) }), { ok: true })
    assert.deepStrictEqual(t.schedules()[0].args, { id: 'progress', atMs: 16000 })
    t.clock.t = 16000
    t.fire('progress', 16000, 16003)
    assert.deepStrictEqual(got, [{ atMs: 16000, t: 16003 }])
    assert.deepStrictEqual(t.schedules()[1].args, { id: 'progress', atMs: 31000 })
    assert.strictEqual(t.tick.isRunning('progress'), true)
  },
  async 'a late tick does not produce a burst: the next one is one period after now'() {
    const t = setup()
    await t.tick.start('progress', { everyMs: 15000, onTick: () => {} })
    t.clock.t = 50000 // 34 s late
    t.fire('progress', 16000, 50000)
    assert.deepStrictEqual(t.schedules()[1].args, { id: 'progress', atMs: 65000 })
  },
  async 'no connection to native: a refused schedule answers an error, leaves no timer and does not throw'() {
    const t = setup({ refuse: true })
    const r = await t.tick.start('progress', { everyMs: 15000, onTick: () => { throw new Error('must not run') } })
    assert.deepStrictEqual(r, { error: 'timer refused' })
    assert.strictEqual(t.tick.isRunning('progress'), false)
    t.fire('progress', 16000)
  },
  async 'a refused reschedule ends the timer instead of ticking without a native schedule'() {
    const t = setup({ refuseAfter: 1 })
    let ticks = 0
    await t.tick.start('progress', { everyMs: 15000, onTick: () => ticks++ })
    t.fire('progress', 16000) // the first tick is delivered; the reschedule is refused
    await new Promise((r) => setTimeout(r, 0))
    assert.strictEqual(ticks, 1)
    assert.strictEqual(t.tick.isRunning('progress'), false)
    t.fire('progress', 31000)
    assert.strictEqual(ticks, 1)
  },
  async 'pause: stop cancels the native timer, and a tick already on its way is ignored'() {
    const t = setup()
    const got = []
    await t.tick.start('progress', { everyMs: 15000, onTick: (x) => got.push(x) })
    assert.deepStrictEqual(await t.tick.stop('progress'), { ok: true })
    assert.deepStrictEqual(t.cancels()[0].args, { id: 'progress' })
    t.fire('progress', 16000)
    assert.deepStrictEqual(got, [])
    assert.strictEqual(t.schedules().length, 1) // no reschedule after the stop
    assert.strictEqual(t.tick.isRunning('progress'), false)
  },
  async 'stop of a timer that is not running sends nothing'() {
    const t = setup()
    assert.deepStrictEqual(await t.tick.stop('nothing'), { ok: true })
    assert.strictEqual(t.calls.length, 0)
  },
  async 'two quick start and stop cycles leave no stray timer: a tick from a stopped cycle is ignored'() {
    const t = setup()
    const got = []
    const onTick = (x) => got.push(x.atMs)
    await t.tick.start('progress', { everyMs: 15000, onTick })
    await t.tick.stop('progress')
    await t.tick.start('progress', { everyMs: 15000, onTick })
    await t.tick.stop('progress')
    t.fire('progress', 16000) // first cycle's tick, native delivered it late
    assert.deepStrictEqual(got, [])
    assert.strictEqual(t.tick.isRunning('progress'), false)
    assert.strictEqual(t.cancels().length, 2)
  },
  async 'restart: a start while running replaces the timer, a tick is delivered once'() {
    const t = setup()
    const got = []
    await t.tick.start('progress', { everyMs: 15000, onTick: () => got.push('old') })
    t.clock.t = 5000
    await t.tick.start('progress', { everyMs: 15000, onTick: (x) => got.push('new:' + x.atMs) })
    t.fire('progress', 16000) // due time of the first start: stale
    assert.deepStrictEqual(got, [])
    t.fire('progress', 20000)
    assert.deepStrictEqual(got, ['new:20000'])
  },
  async 'core crash and restart: the new core ignores the old core\'s tick and starts its timers again'() {
    const old = setup()
    await old.tick.start('progress', { everyMs: 15000, onTick: () => { throw new Error('old core must not tick') } })
    // the core restarts: a new module on a new bridge, the native timer for the old one still fires once
    const fresh = setup()
    fresh.clock.t = 16000
    fresh.fire('progress', 16000)
    assert.strictEqual(fresh.tick.isRunning('progress'), false)
    const got = []
    await fresh.tick.start('progress', { everyMs: 15000, onTick: (x) => got.push(x.atMs) })
    fresh.fire('progress', 31000)
    assert.deepStrictEqual(got, [31000])
  },
  async 'bad start arguments are refused'() {
    const t = setup()
    assert.throws(() => t.tick.start('progress', { everyMs: 0, onTick: () => {} }), /everyMs/)
    assert.throws(() => t.tick.start('progress', { everyMs: 15000 }), /onTick/)
  }
}
let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
