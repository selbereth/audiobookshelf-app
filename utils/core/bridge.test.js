import assert from 'assert'
import { createBridge } from './bridge'

function fake() {
  const sent = []
  const answers = []
  let readied = 0
  const transport = {
    call: (c, m, a, id) => sent.push({ c, m, a, id }),
    answerUp: (id, ok, json) => answers.push({ id, ok, json }),
    ready: () => readied++
  }
  return { sent, answers, transport, readied: () => readied }
}

const tests = {
  async 'call sends JSON and resolves with the parsed reply'() {
    const f = fake(), b = createBridge(f.transport)
    const p = b.call('store', 'get', { key: 'a' })
    assert.deepStrictEqual(f.sent.map(({ c, m, a }) => [c, m, a]), [['store', 'get', '{"key":"a"}']])
    b.handleReply(f.sent[0].id, true, '{"v":1}')
    assert.deepStrictEqual(await p, { v: 1 })
  },
  async 'call rejects when native fails, and resolves undefined on an empty reply'() {
    const f = fake(), b = createBridge(f.transport)
    const bad = b.call('http', 'request')
    const ok = b.call('wake', 'cancel')
    b.handleReply(f.sent[0].id, false, 'boom')
    b.handleReply(f.sent[1].id, true, '')
    await assert.rejects(bad, /boom/)
    assert.strictEqual(await ok, undefined)
  },
  async 'a reply to an unknown id is ignored'() {
    const b = createBridge(fake().transport)
    b.handleReply(99, true, '{}')
  },
  async 'a throwing transport rejects the call'() {
    const b = createBridge({ call() { throw new Error('no web view') }, answerUp() {}, ready() {} })
    await assert.rejects(b.call('x', 'y'), /no web view/)
  },
  async 'events reach handlers in order with the native time'() {
    const b = createBridge(fake().transport)
    const seen = []
    b.on('player', 'position', (d, t) => seen.push([d.ms, t]))
    b.handleEvent('player', 'position', '{"ms":1}', 100)
    b.handleEvent('player', 'position', '{"ms":2}', 200)
    b.handleEvent('player', 'other', '{}', 300)
    assert.deepStrictEqual(seen, [[1, 100], [2, 200]])
  },
  async 'unsubscribe stops events, a throwing handler does not stop the others'() {
    const b = createBridge(fake().transport)
    const a = [], c = []
    const off = b.on('x', 'e', (d) => a.push(d))
    b.on('x', 'e', () => { throw new Error('bad handler') })
    b.on('x', 'e', (d) => c.push(d))
    const log = console.error
    console.error = () => {}
    b.handleEvent('x', 'e', '{"n":1}', 1)
    off()
    b.handleEvent('x', 'e', '{"n":2}', 2)
    console.error = log
    assert.deepStrictEqual(a, [{ n: 1 }])
    assert.deepStrictEqual(c, [{ n: 1 }, { n: 2 }])
  },
  async 'a call up is served and answered with JSON'() {
    const f = fake(), b = createBridge(f.transport)
    b.serve('browse', 'loadChildren', async ({ parentId }) => [{ id: parentId + '/1' }])
    await b.handleCallUp(7, 'browse', 'loadChildren', '{"parentId":"root"}')
    assert.deepStrictEqual(f.answers, [{ id: 7, ok: true, json: '[{"id":"root/1"}]' }])
  },
  async 'a call up with no server, or a failing one, is answered as a failure'() {
    const f = fake(), b = createBridge(f.transport)
    b.serve('browse', 'search', () => { throw new Error('index missing') })
    await b.handleCallUp(1, 'browse', 'nothing', '{}')
    await b.handleCallUp(2, 'browse', 'search', '{}')
    assert.deepStrictEqual(f.answers.map((a) => [a.id, a.ok]), [[1, false], [2, false]])
    assert.match(f.answers[1].json, /index missing/)
  },
  async 'ready is passed to native'() {
    const f = fake(), b = createBridge(f.transport)
    b.ready()
    assert.strictEqual(f.readied(), 1)
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
