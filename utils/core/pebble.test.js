import assert from 'assert'
import { execSync } from 'child_process'
import { createBridge } from './bridge'
import { pebbleModule, shouldNudge, needsReload, pickServerConfig, WAIT_SECONDS, SERVER_CHECK_TIMEOUT_MS } from './modules/pebble'

// Every rule quotes the Kotlin line it ports, from the master commit (the base of this phase). `quote` finds the line by its text and
// checks it, so a quoted line that drifts from the source fails the test. The line is printed in the test output.
const MASTER = '97903e66'
const SRC = {
  AudioPrimitives: 'android/app/src/main/java/com/audiobookshelf/app/pebble/AudioPrimitives.kt',
  PebblePrimitives: 'android/app/src/main/java/com/audiobookshelf/app/pebble/PebblePrimitives.kt'
}
const cache = {}
function quote(file, needle) {
  if (!cache[file]) cache[file] = execSync(`git show ${MASTER}:${SRC[file]}`, { cwd: process.cwd(), maxBuffer: 1 << 24 }).toString().split('\n')
  const i = cache[file].findIndex((l) => l.includes(needle))
  assert.ok(i >= 0, `${file} does not contain '${needle}'`)
  const text = cache[file][i].trim()
  console.log(`    quoted ${file}:${i + 1}: ${text}`)
  return text
}

// A fake native side behind the bridge: `world` holds what the connectors answer and what they were asked
function world(over = {}) {
  const w = {
    live: true,
    state: { live: true, loaded: true, idle: false, lazyPlaying: true, positionSec: 42, session: { displayTitle: 'Book', duration: 100, chapters: [] } },
    connected: true,
    data: { serverConnectionConfigs: [{ id: 'c1', address: 'http://a', token: 't1' }], lastServerConnectionConfigId: 'c1', lastPlaybackSession: null },
    locals: {},
    progress: {},
    hang: false,
    srv: { address: 'http://a', token: 't1', serverConnectionConfigId: 'c1' },
    playItem: { id: 's1', displayTitle: 'Server book' },
    loadLocal: { ok: true },
    requests: {},
    calls: [],
    ...over
  }
  const native = async (connector, method, args) => {
    w.calls.push(connector + '.' + method + (args && Object.keys(args).length ? ' ' + JSON.stringify(args) : ''))
    if (connector === 'player') {
      if (method === 'bind') return { live: w.live }
      if (method === 'getState') return w.state
      if (method === 'playItemPayload') return { mediaTypes: [] }
      if (method === 'loadLocal') return w.loadLocal
      if (method === 'loadSession') return { ok: true }
      return {}
    }
    if (connector === 'pebble' && method === 'savedRate') return 1.5
    if (connector === 'system' && method === 'network') return { connected: w.connected }
    return {}
  }
  const transport = {
    call(connector, method, argsJson, id) {
      Promise.resolve()
        .then(() => native(connector, method, JSON.parse(argsJson)))
        .then((r) => bridge.handleReply(id, true, r === undefined ? '' : JSON.stringify(r)), (e) => bridge.handleReply(id, false, e.message))
    },
    answerUp() {},
    ready() {}
  }
  const bridge = createBridge(transport)
  const api = {
    resolveServer: async () => w.srv,
    request: async ({ endpoint }) => {
      w.calls.push('api.request ' + endpoint)
      if (w.hang) return new Promise(() => {})
      return w.requests[endpoint] || { error: 'Unexpected code 404' }
    }
  }
  const db = {
    methods: {
      getDeviceData: async () => w.data,
      getLocalLibraryItem: async ({ id }) => w.locals[id] || {},
      syncServerMediaProgressWithLocalMediaProgress: async (a) => { w.calls.push('db.syncServerMediaProgress ' + a.localLibraryItemId); return {} }
    },
    store: {
      get: async (collection, key) => (collection === 'localMediaProgress' ? w.progress[key] || null : null),
      put: async (collection, key, value) => { w.calls.push('store.put ' + collection + ' ' + key); if (collection === 'localMediaProgress') w.progress[key] = value }
    },
    serial: async (fn) => fn(),
    addSyncEvent: async () => { w.calls.push('db.addSyncEvent') }
  }
  const logs = []
  const server = {
    playItem: async (a) => {
      w.calls.push('server.playItem ' + a.libraryItemId + ' ' + a.address)
      return w.playItem
    }
  }
  const sleeps = []
  const mod = pebbleModule(bridge, { api, server, db, sleep: async (ms) => sleeps.push(ms), log: (m) => logs.push(m) })
  return { w, bridge, mod, sleeps, logs, has: (s) => w.calls.some((c) => c.startsWith(s)) }
}

const lastBook = { displayTitle: 'Last', libraryItemId: 'li1', episodeId: null, serverConnectionConfigId: 'c1', localLibraryItem: null, localEpisodeId: null, currentTime: 10, updatedAt: 500 }

// A downloaded book linked to server item li1 (config c1), with local progress at 10 s, last updated at 100
const linked = (over = {}) => world({
  locals: { d1: { id: 'd1', libraryItemId: 'li1', serverConnectionConfigId: 'c1', media: {} } },
  progress: { d1: { id: 'd1', libraryItemId: 'li1', episodeId: null, serverConnectionConfigId: 'c1', currentTime: 10, lastUpdate: 100, isFinished: false, progress: 0.1, duration: 100 } },
  ...over
})
const serverAt = (lastUpdate, currentTime = 300) => ({ id: 'mp1', libraryItemId: 'li1', episodeId: null, currentTime, lastUpdate, isFinished: false, progress: currentTime / 100, duration: 100, startedAt: 1, finishedAt: null })

const tests = {
  'WAIT_SECONDS is 20 (AudioPrimitives awaitPlaying)': async () => {
    quote('AudioPrimitives', 'const val WAIT_SECONDS = 20')
    assert.equal(WAIT_SECONDS, 20)
  },

  'awaitPlaying nudges at seconds 2, 5, 8 at most three times, then gives up after 20 s': async () => {
    const line = quote('AudioPrimitives', 'if (second >= 2 && second % 3 == 2 && nudges < 3) {')
    assert.ok(line)
    assert.deepEqual([0, 1, 2, 5, 8, 11].map((s) => shouldNudge(s, 0)), [false, false, true, true, true, true])
    assert.equal(shouldNudge(8, 3), false)
    const { mod, w, has, sleeps } = world({ state: { live: true, loaded: true, idle: false, lazyPlaying: false, positionSec: 0, session: null } })
    w.state = { ...w.state, session: { displayTitle: 'x', duration: 1, chapters: [] } }
    const r = await mod.native.audio.awaitPlaying()
    assert.deepEqual(r, { playing: false })
    assert.equal(sleeps.length, WAIT_SECONDS)
    assert.equal(w.calls.filter((c) => c === 'player.playService').length, 3)
    assert.ok(has('player.playService'))
  },

  'awaitPlaying answers playing as soon as the player reports it (PlayerListener lazyIsPlaying)': async () => {
    quote('AudioPrimitives', 'if (PlayerListener.lazyIsPlaying) return JSONObject().put("playing", true)')
    const { mod, w, sleeps } = world()
    const r = await mod.native.audio.awaitPlaying()
    assert.deepEqual(r, { playing: true })
    assert.equal(sleeps.length, 1)
    assert.ok(!w.calls.some((c) => c.startsWith('player.playService')))
  },

  'playPause toggles a healthy loaded book': async () => {
    quote('AudioPrimitives', 'if (service.hasBook() && !failed) {')
    const { mod, has } = world()
    assert.deepEqual(await mod.native.audio.playPause(), {})
    assert.ok(has('player.playPause'))
    assert.ok(!has('player.loadLocal'))
  },

  'playPause reloads the last book when its load failed (player idle)': async () => {
    quote('AudioPrimitives', 'val failed = withContext(Dispatchers.Main) { service.hasBook() && service.currentPlayer.playbackState == Player.STATE_IDLE }')
    assert.equal(needsReload({ loaded: true, idle: true }), true)
    assert.equal(needsReload({ loaded: false, idle: false }), true)
    const { mod, w, has } = world({ state: { live: true, loaded: true, idle: true }, locals: {} })
    w.data = { ...w.data, lastPlaybackSession: lastBook }
    const r = await mod.native.audio.playPause()
    assert.equal(r.loading, true)
    assert.equal(r.title, 'Last')
    assert.ok(!has('player.playPause'))
    assert.ok(has('server.playItem li1 http://a'))
    assert.ok(has('player.loadSession'))
  },

  'playPause with no book ever played answers the Kotlin error': async () => {
    quote('AudioPrimitives', 'Play a book in Selbershelf on the phone first')
    const { mod } = world({ state: { live: true, loaded: false } })
    assert.deepEqual(await mod.native.audio.playPause(), { error: 'Play a book in Selbershelf on the phone first' })
  },

  'start uses the download when there is one (local preferred)': async () => {
    quote('AudioPrimitives', 'if (localItem != null) {')
    const { mod, w, has } = world({ locals: { d1: { id: 'd1', title: 'Local' } } })
    const r = await mod.native.audio.start({ libraryItemId: 'li9', localLibraryItemId: 'd1' })
    assert.deepEqual(r, { loading: true, title: '' })
    assert.ok(has('player.loadLocal {"localLibraryItemId":"d1"'))
    assert.ok(!has('server.playItem'))
    assert.ok(w)
  },

  'missing download files answer the Kotlin message': async () => {
    quote('AudioPrimitives', 'Audio files are missing: download the book again')
    const { mod } = world({ locals: { d1: { id: 'd1' } }, loadLocal: { ok: false, reason: 'tracks' } })
    assert.deepEqual(await mod.native.audio.start({ localLibraryItemId: 'd1' }), { error: 'Audio files are missing: download the book again' })
  },

  'a server book uses the config it was played from, else the last one used': async () => {
    quote('AudioPrimitives', 'DeviceManager.getServerConnectionConfig(DeviceManager.deviceData.lastServerConnectionConfigId)')
    const data = { serverConnectionConfigs: [{ id: 'a', address: 'http://a', token: 'ta' }, { id: 'b', address: 'http://b', token: 'tb' }], lastServerConnectionConfigId: 'b' }
    assert.equal(pickServerConfig(data, 'a').id, 'a')
    assert.equal(pickServerConfig(data, 'gone').id, 'b')
    assert.equal(pickServerConfig(data, null).id, 'b')
    assert.equal(pickServerConfig({ serverConnectionConfigs: [], lastServerConnectionConfigId: null }, null), null)
    const { mod, has } = world({ data: { ...world().w.data, serverConnectionConfigs: [{ id: 'a', address: 'http://a', token: 'ta' }, { id: 'b', address: 'http://b', token: 'tb' }], lastServerConnectionConfigId: 'b' } })
    await mod.native.audio.start({ libraryItemId: 'li9' })
    assert.ok(has('server.playItem li9 http://b'))
  },

  'no server config answers the Kotlin login message': async () => {
    quote('AudioPrimitives', 'Log in to the server in the app first')
    const { mod } = world({ data: { serverConnectionConfigs: [], lastServerConnectionConfigId: null } })
    assert.deepEqual(await mod.native.audio.start({ libraryItemId: 'li9' }), { error: 'Log in to the server in the app first' })
  },

  'a failed server play answers the Kotlin reach message': async () => {
    quote('AudioPrimitives', 'Could not reach the server')
    const { mod } = world({ playItem: { error: 'Failed to connect' } })
    assert.deepEqual(await mod.native.audio.start({ libraryItemId: 'li9' }), { error: 'Could not reach the server' })
  },

  'get: no server or no connection answers not ok, with no request': async () => {
    quote('PebblePrimitives', 'if (DeviceManager.serverConnectionConfig == null || !DeviceManager.checkConnectivity(context)) return')
    const offline = world({ connected: false })
    assert.deepEqual(await offline.mod.native.api.get('/api/libraries'), { ok: false })
    assert.ok(!offline.has('api.request'))
  },

  'get: asks for the user first (refreshes the token), then the path; a list is answered as an array': async () => {
    quote('PebblePrimitives', 'ApiHandler(context).getCurrentUser { latch.countDown() }')
    quote('PebblePrimitives', 'if (body.trimStart().startsWith("["))')
    const { mod, w } = world({ requests: { '/api/me': { id: 'u' }, '/api/libraries': { value: [{ id: 'l1' }] } } })
    const r = await mod.native.api.get('/api/libraries')
    assert.deepEqual(w.calls.filter((c) => c.startsWith('api.request')), ['api.request /api/me', 'api.request /api/libraries'])
    assert.deepEqual(r, { ok: true, json: [{ id: 'l1' }] })
  },

  'the watch shows the player playing state from lazyIsPlaying, not isPlaying': async () => {
    quote('AudioPrimitives', 'return out.put("playing", PlayerListener.lazyIsPlaying)')
    const { mod } = world({ state: { live: true, loaded: true, idle: false, lazyPlaying: false, playing: true, positionSec: 5, session: { displayTitle: 'B', duration: 9, chapters: [] } } })
    const s = await mod.native.audio.state()
    assert.equal(s.playing, false)
    assert.equal(s.time, 5)
    assert.equal(s.session.title, 'B')
  },

  'nothing loaded: a jump does nothing (AudioPrimitives jump)': async () => {
    quote('AudioPrimitives', 'if (service == null || !service.hasBook()) return')
    const { mod, has } = world({ state: { live: true, loaded: false } })
    await mod.native.audio.jump(true)
    assert.ok(!has('player.jump'))
  },

  'a downloaded book takes the newer server progress before it is loaded': async () => {
    const { mod, w, logs } = linked({ requests: { '/api/me/progress/li1': serverAt(500) } })
    const r = await mod.native.audio.start({ localLibraryItemId: 'd1' })
    assert.deepEqual(r, { loading: true, title: '' })
    const at = (c) => w.calls.findIndex((x) => x.startsWith(c))
    assert.ok(at('api.request /api/me/progress/li1') >= 0)
    assert.ok(at('store.put localMediaProgress d1') > -1 && at('store.put localMediaProgress d1') < at('player.loadLocal'))
    assert.equal(w.progress.d1.currentTime, 300)
    assert.equal(w.progress.d1.lastUpdate, 500)
    assert.ok(w.calls.includes('db.addSyncEvent'))
    assert.ok(logs.includes('Pebble start: server progress is newer (500 vs 100), using it'))
  },

  'the server progress is not written when the local one is as new or newer': async () => {
    for (const lastUpdate of [100, 50]) {
      const { mod, w, logs, has } = linked({ requests: { '/api/me/progress/li1': serverAt(lastUpdate, 999) } })
      await mod.native.audio.start({ localLibraryItemId: 'd1' })
      assert.ok(!w.calls.some((c) => c.startsWith('store.put')))
      assert.equal(w.progress.d1.currentTime, 10)
      assert.ok(has('player.loadLocal'))
      assert.deepEqual(logs, ['Pebble start: local progress is current'])
    }
  },

  'a server error or a missing answer starts from the local progress, with one log line': async () => {
    const { mod, w, logs, has } = linked({ requests: { '/api/me/progress/li1': { error: 'Unexpected code 404' } } })
    assert.deepEqual(await mod.native.audio.start({ localLibraryItemId: 'd1' }), { loading: true, title: '' })
    assert.ok(has('player.loadLocal'))
    assert.equal(w.progress.d1.currentTime, 10)
    assert.deepEqual(logs, ['Pebble start: could not check the server (Unexpected code 404), using local progress'])
  },

  'a server that does not answer in time starts from the local progress': async () => {
    const { mod, w, logs, has } = linked({ hang: true })
    const t0 = Date.now()
    assert.deepEqual(await mod.native.audio.start({ localLibraryItemId: 'd1' }), { loading: true, title: '' })
    const took = Date.now() - t0
    assert.ok(took >= SERVER_CHECK_TIMEOUT_MS - 50 && took < SERVER_CHECK_TIMEOUT_MS + 2000, 'took ' + took + ' ms')
    assert.ok(has('player.loadLocal'))
    assert.ok(!w.calls.some((c) => c.startsWith('store.put')))
    assert.deepEqual(logs, ['Pebble start: could not check the server (no answer in time), using local progress'])
  },

  'offline or not linked to a server: no request, start from the local progress': async () => {
    const offline = linked({ connected: false, requests: { '/api/me/progress/li1': serverAt(500) } })
    await offline.mod.native.audio.start({ localLibraryItemId: 'd1' })
    assert.ok(!offline.has('api.request'))
    assert.ok(offline.has('player.loadLocal'))
    assert.deepEqual(offline.logs, ['Pebble start: could not check the server (offline), using local progress'])

    const unlinked = world({ locals: { d1: { id: 'd1', media: {} } } })
    await unlinked.mod.native.audio.start({ localLibraryItemId: 'd1' })
    assert.ok(!unlinked.has('api.request'))
    assert.ok(unlinked.has('player.loadLocal'))
    assert.deepEqual(unlinked.logs, ['Pebble start: could not check the server (not linked to a server), using local progress'])

    const noConfig = linked({ data: { serverConnectionConfigs: [], lastServerConnectionConfigId: null } })
    await noConfig.mod.native.audio.start({ localLibraryItemId: 'd1' })
    assert.ok(!noConfig.has('api.request'))
    assert.ok(noConfig.has('player.loadLocal'))
  },

  'a downloaded book with no local progress takes the server progress as new': async () => {
    const { mod, w, has } = linked({ progress: {}, requests: { '/api/me/progress/li1': serverAt(500) } })
    await mod.native.audio.start({ localLibraryItemId: 'd1' })
    assert.ok(has('db.syncServerMediaProgress d1'))
    assert.ok(has('player.loadLocal'))
    assert.ok(w.calls.findIndex((c) => c.startsWith('db.syncServerMediaProgress d1')) < w.calls.findIndex((c) => c.startsWith('player.loadLocal')))
  },

  'run answers pebble entry points and rejects unknown ones': async () => {
    const { mod } = world()
    assert.equal(await mod.run('closed'), null)
    await assert.rejects(mod.run('deleteEverything'), /unknown pebble method/)
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    console.log('ok - ' + name)
  } catch (e) {
    failed++
    console.log('not ok - ' + name + '\n    ' + (e && e.message))
  }
}
console.log(`pebble: ${Object.keys(tests).length - failed} ok, ${failed} failed`)
if (failed) process.exit(1)
