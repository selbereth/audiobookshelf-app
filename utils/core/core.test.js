import assert from 'assert'
import { createCore } from './core'

const sent = []
const answers = []
const core = createCore(
  { call: (c, m, a, id) => sent.push({ c, m, a, id }), answerUp: (id, ok, json) => answers.push({ id, ok, json }), ready() {} },
  { log: () => {}, now: () => 1000 }
)

await core.bridge.handleCallUp(1, 'core', 'ping', '{}')
assert.deepStrictEqual(answers[0], { id: 1, ok: true, json: '{"pong":1000}' })

// hello: the core answers the UI and also sends it an event
await core.bridge.handleCallUp(2, 'core', 'hello', '{}')
assert.deepStrictEqual(answers[1], { id: 2, ok: true, json: '{"ok":true}' })
assert.deepStrictEqual([sent[0].c, sent[0].m, sent[0].a], ['ui', 'emit', '{"event":"hello","data":{"t":1000}}'])
core.bridge.handleReply(sent[0].id, false, 'no ui') // emitToUi must not throw when the UI is closed

core.emitToUi('state', { playing: true })
assert.deepStrictEqual([sent[1].c, sent[1].m, sent[1].a], ['ui', 'emit', '{"event":"state","data":{"playing":true}}'])

core.bridge.handleEvent('wake', 'wake', '{"id":"w1","atMs":5,"exact":true}', 10) // no handler registered: ignored
assert.strictEqual(typeof core.saver.restore, 'function') // the saver is registered (Phase 4b-2)
console.log('ok   core serves ping and hello and relays events to the UI')
