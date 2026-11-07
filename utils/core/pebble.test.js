import assert from 'assert'
import { execSync } from 'child_process'
import { createBridge } from './bridge'
import { pebbleModule, shouldNudge, needsReload, pickServerConfig, WAIT_SECONDS } from './modules/pebble'

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
      return w.requests[endpoint] || { error: 'Unexpected code 404' }
    }
  }
  const db = {
    methods: {
      getDeviceData: async () => w.data,
      getLocalLibraryItem: async ({ id }) => w.locals[id] || {}
    }
  }
  const server = {
    playItem: async (a) => {
      w.calls.push('server.playItem ' + a.libraryItemId + ' ' + a.address)
      return w.playItem
    }
  }
  const sleeps = []
  const mod = pebbleModule(bridge, { api, server, db, sleep: async (ms) => sleeps.push(ms) })
  return { w, bridge, mod, sleeps, has: (s) => w.calls.some((c) => c.startsWith(s)) }
}

const lastBook = { displayTitle: 'Last', libraryItemId: 'li1', episodeId: null, serverConnectionConfigId: 'c1', localLibraryItem: null, localEpisodeId: null, currentTime: 10, updatedAt: 500 }

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
