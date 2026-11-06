import assert from 'assert'
import { apiModule } from './modules/api'
import { serverModule } from './modules/server'

// Fake native: records every http request and answers with the scripted server. The device data names the current server (c1)
function setup(server, { current = 'c1' } = {}) {
  const served = {}, requests = []
  const bridge = {
    serve: (c, m, fn) => { served[m] = fn },
    call: async (connector, method, a) => {
      if (connector === 'http') { requests.push(a); return server(a) }
      throw new Error('unexpected ' + connector + '.' + method)
    }
  }
  const data = {
    lastServerConnectionConfigId: current,
    serverConnectionConfigs: [{ id: 'c1', address: 'https://cur', token: 'curtok', name: 'current' }, { id: 'c2', address: 'https://other', token: 'othertok', name: 'other' }]
  }
  const db = { methods: { getDeviceData: async () => data } }
  const api = apiModule(bridge, { log: () => {}, db })
  serverModule(bridge, { api })
  const call = (m, args) => served['server.' + m](args)
  return { call, requests, served }
}
const ok = (obj) => ({ status: 200, headers: {}, body: typeof obj === 'string' ? obj : JSON.stringify(obj) })
const fail = { status: 500, headers: {}, body: '' }
const unreachable = () => { throw new Error('socket closed') }
const named = { address: 'https://s', token: 'tok', serverConnectionConfigId: 'c9' }

const tests = {
  async 'the module serves ping, authorize and playItem'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(Object.keys(t.served).filter((m) => m.startsWith('server.')).sort(), ['server.authorize', 'server.ping', 'server.playItem'])
  },
  async 'ping: GET /ping with a 3 s timeout, reachable when the server answers success'() {
    const t = setup(() => ok({ success: true }))
    assert.deepStrictEqual(await t.call('ping', named), { reachable: true })
    assert.strictEqual(t.requests[0].method, 'GET'); assert.strictEqual(t.requests[0].url, 'https://s/ping')
    assert.strictEqual(t.requests[0].timeoutMs, 3000); assert.strictEqual(t.requests[0].headers.Authorization, 'Bearer tok')
  },
  async 'ping: server error and no connection both answer not reachable'() {
    assert.deepStrictEqual(await setup(() => fail).call('ping', named), { reachable: false })
    assert.deepStrictEqual(await setup(unreachable).call('ping', named), { reachable: false })
  },
  async 'ping: without a named server it pings the current one'() {
    const t = setup(() => ok({ success: true }))
    assert.deepStrictEqual(await t.call('ping', {}), { reachable: true })
    assert.strictEqual(t.requests[0].url, 'https://cur/ping'); assert.strictEqual(t.requests[0].headers.Authorization, 'Bearer curtok')
  },
  async 'authorize: POST {} and answers the mediaProgress list of the user'() {
    const progress = [{ libraryItemId: 'li-1', currentTime: 5 }]
    const t = setup(() => ok({ user: { mediaProgress: progress } }))
    assert.deepStrictEqual(await t.call('authorize', named), { mediaProgress: progress })
    assert.strictEqual(t.requests[0].method, 'POST'); assert.strictEqual(t.requests[0].url, 'https://s/api/authorize'); assert.strictEqual(t.requests[0].body, '{}')
    assert.deepStrictEqual(await setup(() => ok({ user: {} })).call('authorize', named), { mediaProgress: [] })
  },
  async 'authorize: server error and no connection are answered as {error}'() {
    assert.deepStrictEqual(await setup(() => fail).call('authorize', named), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('authorize', named), { error: 'Failed to connect' })
  },
  async 'playItem: POST the payload to the book or the episode, answers the session with the server it used'() {
    const session = { id: 'ps1', libraryItemId: 'li-1' }
    const t = setup(() => ok(session))
    const payload = { deviceInfo: { deviceId: 'd' }, supportedMimeTypes: ['audio/mpeg'] }
    const r = await t.call('playItem', { libraryItemId: 'li-1', episodeId: '', payload })
    assert.deepStrictEqual(r, { ...session, serverConnectionConfigId: 'c1', serverAddress: 'https://cur' })
    assert.strictEqual(t.requests[0].method, 'POST'); assert.strictEqual(t.requests[0].url, 'https://cur/api/items/li-1/play')
    assert.deepStrictEqual(JSON.parse(t.requests[0].body), payload)
    await t.call('playItem', { libraryItemId: 'li-1', episodeId: 'ep-2', payload: {} })
    assert.strictEqual(t.requests[1].url, 'https://cur/api/items/li-1/play/ep-2')
  },
  async 'playItem: a named server is used instead of the current one'() {
    const t = setup(() => ok({ id: 'ps1' }))
    const r = await t.call('playItem', { ...named, libraryItemId: 'li-1', episodeId: '', payload: {} })
    assert.strictEqual(r.serverConnectionConfigId, 'c9'); assert.strictEqual(r.serverAddress, 'https://s')
    assert.strictEqual(t.requests[0].url, 'https://s/api/items/li-1/play')
  },
  async 'playItem: server error, no connection, and no current server are answered as {error}'() {
    assert.deepStrictEqual(await setup(() => fail).call('playItem', { libraryItemId: 'li-1', payload: {} }), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('playItem', { libraryItemId: 'li-1', payload: {} }), { error: 'Failed to connect' })
    const none = setup(() => ok({}), { current: null })
    assert.deepStrictEqual(await none.call('playItem', { libraryItemId: 'li-1', payload: {} }), { error: 'No server connection' })
    assert.strictEqual(none.requests.length, 0)
  }
}
let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
