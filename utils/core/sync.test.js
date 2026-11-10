import assert from 'assert'
import { dbModule } from './modules/db'
import { apiModule } from './modules/api'
import { syncModule } from './modules/sync'

function setup(server, log = () => {}) {
  const data = {}, secure = { c1: 'r1' }, served = {}, requests = []
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
      if (connector === 'secure') return method === 'get' ? { value: secure[a.key] ?? null } : { stored: true }
      if (connector === 'device') return
      if (connector === 'system') return { sdk: 36, manufacturer: 'G', model: 'P', deviceId: 'dev', versionName: '1.0' }
      if (connector === 'http') { requests.push(a); return server(a) }
      throw new Error('unexpected ' + connector + '.' + method)
    }
  }
  let clock = 5000
  const db = dbModule(bridge, { log: () => {}, now: () => clock, emitToUi: () => {} })
  const api = apiModule(bridge, { log: () => {}, db })
  const sync = syncModule(bridge, { log, db, api })
  const cfg = { id: 'c1', name: 's', address: 'https://s', userId: 'u', username: 'sam', version: '1', token: 'tok', index: 0, customHeaders: null }
  data.device = { data: JSON.stringify({ serverConnectionConfigs: [cfg], lastServerConnectionConfigId: 'c1', lastPlaybackSession: null, deviceSettings: {} }) }
  const put = (c, k, v) => ((data[c] ||= {})[k] = JSON.stringify(v))
  const get = (c, k) => (data[c] && k in data[c] ? JSON.parse(data[c][k]) : null)
  return { sync, put, get, data, requests }
}
const ok = (o) => ({ status: 200, headers: {}, body: JSON.stringify(o) })
const lmp = (id, extra) => ({ id, localLibraryItemId: id, libraryItemId: 'li-' + id, episodeId: null, serverConnectionConfigId: 'c1', progress: 0.1, currentTime: 10, isFinished: false, lastUpdate: 100, ebookLocation: null, ebookProgress: null, ...extra })

const tests = {
  async 'a server row with no lastUpdate is not treated as up to date: it is skipped and logged'() {
    const lines = []
    const t = setup(() => ok({ mediaProgress: [{ libraryItemId: 'li-a', episodeId: null, progress: 0.9, currentTime: 90, isFinished: false, duration: 100, startedAt: 1 }] }), (m) => lines.push(m))
    t.put('localMediaProgress', 'a', lmp('a'))
    await t.sync.syncLocalSessionsWithServer()
    assert.strictEqual(t.get('localMediaProgress', 'a').currentTime, 10, 'local progress kept, nothing taken from the row')
    assert.strictEqual(t.requests.length, 1, 'only the user request, no PATCH')
    assert.ok(lines.some((l) => l.includes('no lastUpdate')), 'the row is logged')
    assert.ok(lines.some((l) => l.endsWith('0 up-to-date, 0 updated')), 'it is not counted as up to date')
  },
  async 'no connection: nothing happens'() {
    const t = setup(() => ok({}))
    t.data.device.data = JSON.stringify({ serverConnectionConfigs: [], lastServerConnectionConfigId: null })
    assert.deepStrictEqual(await t.sync.syncLocalSessionsWithServer(), {})
    assert.strictEqual(t.requests.length, 0)
  },
  async 'newer server progress replaces local and adds a history event'() {
    const t = setup(() => ok({ mediaProgress: [{ libraryItemId: 'li-a', episodeId: null, progress: 0.5, currentTime: 50, isFinished: false, lastUpdate: 200, duration: 100, startedAt: 1 }] }))
    t.put('localMediaProgress', 'a', lmp('a'))
    t.put('mediaItemHistory', 'li-a', { id: 'li-a', events: [] })
    await t.sync.syncLocalSessionsWithServer()
    assert.strictEqual(t.get('localMediaProgress', 'a').currentTime, 50)
    assert.strictEqual(t.get('localMediaProgress', 'a').lastUpdate, 200)
    assert.strictEqual(t.get('mediaItemHistory', 'li-a').events[0].description, 'Sync on server connection')
  },
  async 'newer local ebook position is patched up, audio is left'() {
    const t = setup((a) => ok(a.method === 'PATCH' ? {} : { mediaProgress: [{ libraryItemId: 'li-a', episodeId: null, lastUpdate: 50, ebookLocation: 'x' }] }))
    t.put('localMediaProgress', 'a', lmp('a', { ebookLocation: 'y', ebookProgress: 0.3, lastUpdate: 100 }))
    await t.sync.syncLocalSessionsWithServer()
    const patch = t.requests.find((r) => r.method === 'PATCH')
    assert.strictEqual(patch.url, 'https://s/api/me/progress/li-a')
    assert.deepStrictEqual(JSON.parse(patch.body), { ebookLocation: 'y', ebookProgress: 0.3, lastUpdate: 100 })
    assert.strictEqual(t.get('localMediaProgress', 'a').ebookLocation, 'y')
  },
  async 'saved sessions: sent, results logged as events, removed; other servers kept'() {
    const sess = (id, extra) => ({ id, userId: 'u', libraryItemId: 'li-' + id, episodeId: null, displayTitle: 'T' + id, serverConnectionConfigId: 'c1', currentTime: 7, ...extra })
    const t = setup((a) => ok(a.url.endsWith('local-all') ? { results: [{ id: 's1', success: true, progressSynced: true }, { id: 's2', success: true, progressSynced: false }] } : { mediaProgress: [] }))
    t.put('localMediaProgress', 'a', lmp('a'))
    t.put('playbackSession', 's1', sess('s1')); t.put('playbackSession', 's2', sess('s2')); t.put('playbackSession', 's3', sess('s3', { serverConnectionConfigId: 'other' }))
    assert.deepStrictEqual(await t.sync.syncLocalSessionsWithServer(), {})
    const body = JSON.parse(t.requests.find((r) => r.url.endsWith('local-all')).body)
    assert.deepStrictEqual(body.sessions.map((s) => s.id), ['s1', 's2'])
    assert.deepStrictEqual(body.deviceInfo, { deviceId: 'dev', manufacturer: 'G', model: 'P', sdkVersion: 36, clientVersion: '1.0' })
    const h = t.get('mediaItemHistory', 'li-s1')
    assert.strictEqual(h.events[0].name, 'Save'); assert.strictEqual(h.events[0].serverSyncSuccess, true); assert.strictEqual(h.events[0].currentTime, 7)
    assert.strictEqual(t.get('mediaItemHistory', 'li-s2'), null)
    assert.strictEqual(t.get('playbackSession', 's1'), null); assert.strictEqual(t.get('playbackSession', 's2'), null)
    assert.notStrictEqual(t.get('playbackSession', 's3'), null)
  },
  async 'a failed upload keeps the sessions and returns the error'() {
    const t = setup((a) => (a.url.endsWith('local-all') ? { status: 500, headers: {}, body: '' } : ok({ mediaProgress: [] })))
    t.put('localMediaProgress', 'a', lmp('a'))
    t.put('playbackSession', 's1', { id: 's1', serverConnectionConfigId: 'c1', libraryItemId: 'x' })
    assert.deepStrictEqual(await t.sync.syncLocalSessionsWithServer(), { error: 'Unexpected code 500' })
    assert.notStrictEqual(t.get('playbackSession', 's1'), null)
  }
}
let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
