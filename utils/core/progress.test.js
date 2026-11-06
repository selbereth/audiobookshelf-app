import assert from 'assert'
import { dbModule } from './modules/db'
import { apiModule } from './modules/api'
import { progressModule } from './modules/progress'

// Fake native: records every http request and answers with the scripted server (handler gets {method,url,headers,body,timeoutMs})
function setup(server) {
  const served = {}, requests = []
  const bridge = {
    serve: (c, m, fn) => { served[m] = fn },
    call: async (connector, method, a) => {
      if (connector === 'http') { requests.push(a); return server(a) }
      throw new Error('unexpected ' + connector + '.' + method)
    }
  }
  const db = dbModule(bridge, { log: () => {}, now: () => 1, emitToUi: () => {} })
  const api = apiModule(bridge, { log: () => {}, db })
  progressModule(bridge, { api })
  const call = (m, args) => served['progress.' + m](args)
  return { call, requests, served }
}
const server = { address: 'https://s', token: 'tok', serverConnectionConfigId: 'c1' }
const ok = (obj) => ({ status: 200, headers: {}, body: typeof obj === 'string' ? obj : JSON.stringify(obj) })
const fail = { status: 500, headers: {}, body: '' }
const unreachable = () => { throw new Error('socket closed') }
const session = {
  id: 'ps1', userId: 'u', libraryItemId: 'li-1', episodeId: null, mediaType: 'book', displayTitle: 'T', displayAuthor: 'A', duration: 100,
  playMethod: 0, startedAt: 1, updatedAt: 2, timeListening: 3, currentTime: 42, mediaPlayer: 'exo', serverConnectionConfigId: 'c1',
  localLibraryItem: { id: 'x' }, chapters: [], audioTracks: [], deviceInfo: { deviceId: 'd', manufacturer: 'G', model: 'P', sdkVersion: 36, clientVersion: '1' }
}

const tests = {
  async 'the module serves the five progress methods'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(Object.keys(t.served).filter((m) => m.startsWith('progress.')).sort(), ['progress.closeSession', 'progress.getMedia', 'progress.sendLocalSession', 'progress.sendSession', 'progress.updateMedia'])
  },
  async 'sendSession: POST the sync payload to the session, answers {}'() {
    const t = setup(() => ok('OK'))
    assert.deepStrictEqual(await t.call('sendSession', { ...server, sessionId: 's1', syncData: { timeListened: 5, duration: 100, currentTime: 42 } }), {})
    const r = t.requests[0]
    assert.strictEqual(r.method, 'POST'); assert.strictEqual(r.url, 'https://s/api/session/s1/sync')
    assert.strictEqual(r.headers.Authorization, 'Bearer tok')
    assert.deepStrictEqual(JSON.parse(r.body), { timeListened: 5, duration: 100, currentTime: 42 })
  },
  async 'sendSession: server error is answered as {error}'() {
    const t = setup(() => fail)
    assert.deepStrictEqual(await t.call('sendSession', { ...server, sessionId: 's1', syncData: {} }), { error: 'Unexpected code 500' })
  },
  async 'sendSession: no connection is answered as {error}'() {
    const t = setup(unreachable)
    assert.deepStrictEqual(await t.call('sendSession', { ...server, sessionId: 's1', syncData: {} }), { error: 'Failed to connect' })
  },
  async 'sendLocalSession: the server gets the partial session with deviceInfo, answers {}'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(await t.call('sendLocalSession', { ...server, session }), {})
    const r = t.requests[0]
    assert.strictEqual(r.method, 'POST'); assert.strictEqual(r.url, 'https://s/api/session/local')
    const body = JSON.parse(r.body)
    assert.deepStrictEqual(Object.keys(body).sort(), ['currentTime', 'deviceInfo', 'displayAuthor', 'displayTitle', 'duration', 'episodeId', 'id', 'libraryItemId', 'mediaPlayer', 'mediaType', 'playMethod', 'startedAt', 'timeListening', 'updatedAt', 'userId'])
    assert.strictEqual(body.episodeId, null); assert.strictEqual(body.currentTime, 42)
    assert.deepStrictEqual(body.deviceInfo, session.deviceInfo)
  },
  async 'sendLocalSession: server error and no connection'() {
    assert.deepStrictEqual(await setup(() => fail).call('sendLocalSession', { ...server, session }), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('sendLocalSession', { ...server, session }), { error: 'Failed to connect' })
  },
  async 'updateMedia: PATCH to the book or to the episode endpoint'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(await t.call('updateMedia', { ...server, libraryItemId: 'li-1', updatePayload: { isFinished: true } }), {})
    assert.deepStrictEqual(await t.call('updateMedia', { ...server, libraryItemId: 'li-1', episodeId: 'ep-2', updatePayload: { isFinished: false } }), {})
    assert.strictEqual(t.requests[0].method, 'PATCH'); assert.strictEqual(t.requests[0].url, 'https://s/api/me/progress/li-1')
    assert.deepStrictEqual(JSON.parse(t.requests[0].body), { isFinished: true })
    assert.strictEqual(t.requests[1].url, 'https://s/api/me/progress/li-1/ep-2')
  },
  async 'updateMedia: server error and no connection'() {
    assert.deepStrictEqual(await setup(() => fail).call('updateMedia', { ...server, libraryItemId: 'li-1', updatePayload: {} }), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('updateMedia', { ...server, libraryItemId: 'li-1', updatePayload: {} }), { error: 'Failed to connect' })
  },
  async 'closeSession: POST with an empty body, answers {}'() {
    const t = setup(() => ok({}))
    assert.deepStrictEqual(await t.call('closeSession', { ...server, playbackSessionId: 'ps1' }), {})
    assert.strictEqual(t.requests[0].url, 'https://s/api/session/ps1/close')
    assert.strictEqual(t.requests[0].body, '{}')
  },
  async 'closeSession: server error and no connection'() {
    assert.deepStrictEqual(await setup(() => fail).call('closeSession', { ...server, playbackSessionId: 'ps1' }), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('closeSession', { ...server, playbackSessionId: 'ps1' }), { error: 'Failed to connect' })
  },
  async 'getMedia: GET with a 3 s timeout, answers the progress object'() {
    const progress = { libraryItemId: 'li-1', currentTime: 10, lastUpdate: 5 }
    const t = setup(() => ok(progress))
    assert.deepStrictEqual(await t.call('getMedia', { ...server, libraryItemId: 'li-1' }), progress)
    assert.strictEqual(t.requests[0].method, 'GET'); assert.strictEqual(t.requests[0].url, 'https://s/api/me/progress/li-1')
    assert.strictEqual(t.requests[0].timeoutMs, 3000)
    await t.call('getMedia', { ...server, libraryItemId: 'li-1', episodeId: 'ep-2' })
    assert.strictEqual(t.requests[1].url, 'https://s/api/me/progress/li-1/ep-2')
  },
  async 'getMedia: server error and no connection are answered as {error}'() {
    assert.deepStrictEqual(await setup(() => fail).call('getMedia', { ...server, libraryItemId: 'li-1' }), { error: 'Unexpected code 500' })
    assert.deepStrictEqual(await setup(unreachable).call('getMedia', { ...server, libraryItemId: 'li-1' }), { error: 'Failed to connect' })
  }
}
let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
