import assert from 'assert'
import { createCore } from './core'

const sent = []
const answers = []
const core = createCore(
  { call: (c, m, a, id) => sent.push({ c, m, a, id }), answerUp: (id, ok, json) => answers.push({ id, ok, json }), ready() {} },
  { log: () => {}, now: () => 1000 }
)

// The core reads the saver switch at start (system.flags); it is the first call, before any UI call
assert.deepStrictEqual([sent[0].c, sent[0].m, sent[0].a], ['system', 'flags', '{}'])
core.bridge.handleReply(sent[0].id, true, '{"coreSaver":false}')

const uiEmits = () => sent.filter((s) => s.c === 'ui')

await core.bridge.handleCallUp(1, 'core', 'ping', '{}')
assert.deepStrictEqual(answers[0], { id: 1, ok: true, json: '{"pong":1000}' })

// hello: the core answers the UI and also sends it an event
await core.bridge.handleCallUp(2, 'core', 'hello', '{}')
assert.deepStrictEqual(answers[1], { id: 2, ok: true, json: '{"ok":true}' })
assert.deepStrictEqual([uiEmits()[0].c, uiEmits()[0].m, uiEmits()[0].a], ['ui', 'emit', '{"event":"hello","data":{"t":1000}}'])
core.bridge.handleReply(uiEmits()[0].id, false, 'no ui') // emitToUi must not throw when the UI is closed

core.emitToUi('state', { playing: true })
assert.deepStrictEqual([uiEmits()[1].c, uiEmits()[1].m, uiEmits()[1].a], ['ui', 'emit', '{"event":"state","data":{"playing":true}}'])

core.bridge.handleEvent('wake', 'wake', '{"id":"w1","atMs":5,"exact":true}', 10) // no handler registered: ignored
assert.strictEqual(typeof core.saver.restore, 'function') // the saver is registered (Phase 4b-2)
console.log('ok   core serves ping and hello and relays events to the UI')

// Switch off (the reply above): a player event does nothing, nothing is asked of native
const before = sent.length
core.bridge.handleEvent('player', 'state', '{"reason":"playing","sessionId":"ps1","playing":true,"positionSec":5}', 2000)
await new Promise((r) => setTimeout(r, 10))
assert.strictEqual(sent.length, before, 'with the switch off the core sends nothing for a player event')
console.log('ok   with the switch off the core saver sends nothing for a player event')

// Switch on: the core reads the network and asks native for the open session (restore after a restart)
const on = []
const onCore = createCore(
  { call: (c, m, a, id) => on.push({ c, m, a, id }), answerUp() {}, ready() {} },
  { log: () => {}, now: () => 1000 }
)
const flagId = on[0].id
assert.deepStrictEqual([on[0].c, on[0].m], ['system', 'flags'])
onCore.bridge.handleReply(flagId, true, '{"coreSaver":true}')
await new Promise((r) => setTimeout(r, 10))
assert.deepStrictEqual([on[1].c, on[1].m], ['system', 'network'], 'the network is read at start when the switch is on')
onCore.bridge.handleReply(on[1].id, true, '{"connected":true,"metered":false,"wifi":true,"validated":true}')
await new Promise((r) => setTimeout(r, 10))
assert.deepStrictEqual([on[2].c, on[2].m], ['player', 'getState'], 'then the open session is restored from native')
console.log('ok   with the switch on the core reads the network and asks native for the open session at start')
