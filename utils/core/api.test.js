import assert from 'assert'
import { dbModule } from './modules/db'
import { apiModule } from './modules/api'

// Fake native: in-memory store/secure, and a scripted server (handler gets {method,url,headers,body})
function setup(server) {
  const data = {}, secure = {}, served = {}, ui = [], deviceCalls = [], requests = []
  const bridge = {
    serve: (c, m, fn) => { served[m] = fn },
    call: async (connector, method, a) => {
      if (connector === 'store') {
        const col = (data[a.collection] ||= {})
        if (method === 'get') return { value: a.key in col ? col[a.key] : null }
        if (method === 'put') { col[a.key] = a.value; return }
        if (method === 'delete') { delete col[a.key]; return }
        if (method === 'list') return { items: Object.entries(col).map(([key, value]) => ({ key, value })) }
      }
      if (connector === 'secure') {
        if (method === 'put') { secure[a.key] = a.value; return { stored: true } }
        if (method === 'get') return { value: secure[a.key] ?? null }
        if (method === 'delete') { const had = a.key in secure; delete secure[a.key]; return { removed: had } }
      }
      if (connector === 'device') { deviceCalls.push(a); return }
      if (connector === 'http') { requests.push(a); return server(a) }
      throw new Error('unexpected ' + connector + '.' + method)
    }
  }
  const db = dbModule(bridge, { log: () => {}, now: () => 1, emitToUi: (e, d) => ui.push([e, d]), btoa: (s) => Buffer.from(s, 'binary').toString('base64') })
  const api = apiModule(bridge, { log: () => {}, db })
  const cfg = { id: 'c1', name: 's', address: 'https://s', userId: 'u', username: 'sam', version: '1', token: 'old', index: 0, customHeaders: null }
  data.device = { data: JSON.stringify({ serverConnectionConfigs: [cfg], lastServerConnectionConfigId: 'c1', lastPlaybackSession: null, deviceSettings: {} }) }
  secure.c1 = 'r1'
  return { served, data, secure, ui, deviceCalls, requests, api, device: () => JSON.parse(data.device.data) }
}
const req = { method: 'GET', endpoint: '/api/me', address: 'https://s', token: 'old', serverConnectionConfigId: 'c1' }
const ok = (obj) => ({ status: 200, headers: {}, body: typeof obj === 'string' ? obj : JSON.stringify(obj) })

const tests = {
  async 'success: bearer header, object, array wrapped, OK as {}'() {
    const t = setup((a) => (a.url.endsWith('/arr') ? ok([1]) : a.url.endsWith('/ok') ? ok('OK') : ok({ id: 'u' })))
    assert.deepStrictEqual(await t.api.request(req), { id: 'u' })
    assert.strictEqual(t.requests[0].headers.Authorization, 'Bearer old')
    assert.deepStrictEqual(await t.api.request({ ...req, endpoint: '/arr' }), { value: [1] })
    assert.deepStrictEqual(await t.api.request({ ...req, endpoint: '/ok' }), {})
  },
  async 'errors: status, connect failure, invalid body'() {
    let mode = 500
    const t = setup(() => { if (mode === 'throw') throw new Error('x'); return mode === 'bad' ? ok('<html>') : { status: mode, headers: {}, body: '' } })
    assert.deepStrictEqual(await t.api.request(req), { error: 'Unexpected code 500' })
    mode = 'throw'
    assert.deepStrictEqual(await t.api.request(req), { error: 'Failed to connect' })
    mode = 'bad'
    assert.deepStrictEqual(await t.api.request(req), { error: 'Invalid response body' })
  },
  async 'no access token: nothing is sent, a clear error is answered'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(await t.api.request({ ...req, token: '' }), { error: 'No access token for this server' })
    assert.deepStrictEqual(await t.api.request({ ...req, token: undefined }), { error: 'No access token for this server' })
    assert.strictEqual(t.requests.length, 0, 'no request was sent')
  },
  async 'anonymous call (ping): sent with no Authorization header at all, not an empty bearer'() {
    const t = setup(() => ok({ success: true }))
    assert.deepStrictEqual(await t.api.request({ method: 'GET', endpoint: '/ping', address: 'https://s', token: '', anonymous: true }), { success: true })
    assert.strictEqual('Authorization' in t.requests[0].headers, false)
  },
  async 'POST sends the payload as JSON'() {
    const t = setup(() => ok({}))
    await t.api.request({ ...req, method: 'POST', payload: { a: 1 } })
    assert.strictEqual(t.requests[0].body, '{"a":1}')
  },
  async '401 refreshes once, retries with the new token, stores tokens, tells the UI'() {
    const t = setup((a) => {
      if (a.url.endsWith('/auth/refresh')) return ok({ user: { accessToken: 'new', refreshToken: 'r2' } })
      return a.headers.Authorization === 'Bearer new' ? ok({ id: 'u' }) : { status: 401, headers: {}, body: '' }
    })
    assert.deepStrictEqual(await t.api.request(req), { id: 'u' })
    assert.strictEqual(t.requests.find((r) => r.url.endsWith('/auth/refresh')).headers['x-refresh-token'], 'r1')
    assert.strictEqual(t.secure.c1, 'r2')
    assert.strictEqual(t.device().serverConnectionConfigs[0].token, 'new')
    assert.deepStrictEqual(t.ui, [['onTokenRefresh', { accessToken: 'new' }]])
    assert.deepStrictEqual(t.deviceCalls.at(-1), { currentServerId: 'c1' })
  },
  async 'concurrent 401s share one refresh'() {
    let refreshes = 0
    const t = setup((a) => {
      if (a.url.endsWith('/auth/refresh')) { refreshes++; return ok({ user: { accessToken: 'new' } }) }
      return a.headers.Authorization === 'Bearer new' ? ok({}) : { status: 401, headers: {}, body: '' }
    })
    await Promise.all([t.api.request(req), t.api.request({ ...req, endpoint: '/api/x' })])
    assert.strictEqual(refreshes, 1)
    assert.strictEqual(t.secure.c1, 'r1', 'refresh token kept when the server sends none')
  },
  async 'refresh rejected: session cleared, UI told, error returned'() {
    const t = setup((a) => (a.url.endsWith('/auth/refresh') ? { status: 401, headers: {}, body: '' } : { status: 401, headers: {}, body: '' }))
    assert.deepStrictEqual(await t.api.request(req), { error: 'Authentication failed - login again' })
    assert.strictEqual('c1' in t.secure, false)
    assert.strictEqual(t.device().lastServerConnectionConfigId, null)
    assert.strictEqual(t.ui[0][0], 'onTokenRefreshFailure')
    assert.strictEqual(t.ui[0][1].serverConnectionConfigId, 'c1')
  },
  async 'refresh transient (500 or unreachable): nothing cleared, the user is not asked to log in again'() {
    const t = setup((a) => (a.url.endsWith('/auth/refresh') ? { status: 503, headers: {}, body: '' } : { status: 401, headers: {}, body: '' }))
    assert.deepStrictEqual(await t.api.request(req), { error: 'Could not refresh the login - try again' })
    assert.strictEqual(t.secure.c1, 'r1')
    assert.strictEqual(t.device().lastServerConnectionConfigId, 'c1')
    assert.deepStrictEqual(t.ui, [])
  },
  async 'rejected while another refresh replaced the token: retries with the new one'() {
    let n = 0
    let t
    t = setup((a) => {
      if (!a.url.endsWith('/auth/refresh')) return { status: 401, headers: {}, body: '' }
      if (n++ === 0) { t.secure.c1 = 'r-other'; return { status: 401, headers: {}, body: '' } }
      assert.strictEqual(a.headers['x-refresh-token'], 'r-other')
      return ok({ user: { accessToken: 'n2' } })
    })
    assert.deepStrictEqual(await t.api.refreshAuthTokens({ serverConnectionConfigId: 'c1' }), { result: 'success', accessToken: 'n2' })
  },
  async 'non-current server: token saved, UI not told'() {
    const t = setup(() => ok({ user: { accessToken: 'z' } }))
    const d = t.device(); d.lastServerConnectionConfigId = 'other'; t.data.device.data = JSON.stringify(d)
    assert.strictEqual((await t.api.refreshAuthTokens({ serverConnectionConfigId: 'c1' })).result, 'success')
    assert.deepStrictEqual(t.ui, [])
    assert.deepStrictEqual(t.deviceCalls.at(-1), {})
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
