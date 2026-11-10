import assert from 'assert'
import { dbModule } from './modules/db'
import * as rules from './modules/dbRules'

// A fake native side: in-memory store, secure, files, device
function setup({ existing = {}, coreUi = false } = {}) {
  const data = {} // collection -> {key: json string}
  const secure = {}
  const deviceCalls = []
  const served = {}
  const ui = []
  let clock = 1_000_000
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
      if (connector === 'files' && method === 'exists') return { exists: existing[a.contentUrl || a.path] !== false }
      if (connector === 'device') { deviceCalls.push(a); return }
      if (connector === 'system' && method === 'flags') return { coreSaver: false, coreSleep: false, coreUi }
      throw new Error('unexpected ' + connector + '.' + method)
    }
  }
  const mod = dbModule(bridge, { log: () => {}, now: () => clock, emitToUi: (e, d) => ui.push([e, d]), btoa: (s) => Buffer.from(s, 'binary').toString('base64') })
  const call = (name, args) => served['db.' + name](args)
  const put = (c, k, v) => ((data[c] ||= {})[k] = JSON.stringify(v))
  const get = (c, k) => (data[c] && k in data[c] ? JSON.parse(data[c][k]) : null)
  return { call, put, get, data, secure, deviceCalls, ui, tick: (ms) => (clock += ms), mod, now: () => clock }
}

const book = (id, extra = {}) => ({
  id, folderId: 'f1', basePath: '', absolutePath: '', contentUrl: '', isInvalid: false, mediaType: 'book',
  media: { duration: 100, tracks: [{ index: 1, localFileId: id + 'a', title: 'A' }, { index: 2, localFileId: id + 'b', title: 'B' }] },
  localFiles: [{ id: id + 'a', absolutePath: '/x/a.mp3', contentUrl: 'content://a' }, { id: id + 'b', absolutePath: '/x/b.mp3', contentUrl: 'file:///b' }],
  coverContentUrl: null, coverAbsolutePath: null, isLocal: true,
  serverConnectionConfigId: 'cfg', serverAddress: 'https://s', serverUserId: 'u', libraryItemId: 'li-' + id, ...extra
})

const tests = {
  async 'device data: defaults, and nulls filled without touching set values'() {
    const t = setup()
    const fresh = await t.call('getDeviceData')
    assert.deepStrictEqual(fresh.deviceSettings, rules.defaultDeviceSettings())
    t.put('device', 'data', { serverConnectionConfigs: [], lastServerConnectionConfigId: null, lastPlaybackSession: null, deviceSettings: { ...rules.defaultDeviceSettings(), jumpForwardTime: 30, languageCode: null, shakeSensitivity: null } })
    const { changed } = await t.mod.startup()
    assert.strictEqual(changed, true)
    const saved = t.get('device', 'data')
    assert.strictEqual(saved.deviceSettings.jumpForwardTime, 30)
    assert.strictEqual(saved.deviceSettings.languageCode, 'en-us')
    assert.strictEqual(saved.deviceSettings.shakeSensitivity, 'MEDIUM')
    assert.deepStrictEqual(t.deviceCalls, [{}], 'native is told to reload')
    assert.strictEqual((await t.mod.startup()).changed, false)
  },
  async 'a new server connection: id, secure refresh token, last config, native follows'() {
    const t = setup()
    const cfg = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u1', username: 'sam', version: '2.30.0', token: 'tok', refreshToken: 'ref', address: 'https://abs.example', customHeaders: { a: 'b' } })
    assert.strictEqual(cfg.id, Buffer.from('https://abs.example@sam').toString('base64').replace(/\+/g, '-').replace(/\//g, '_'))
    assert.strictEqual(cfg.name, 'https://abs.example (sam)')
    assert.strictEqual(cfg.index, 0)
    assert.strictEqual(t.secure[cfg.id], 'ref')
    const device = t.get('device', 'data')
    assert.strictEqual(device.lastServerConnectionConfigId, cfg.id)
    assert.deepStrictEqual(t.deviceCalls, [{ currentServerId: cfg.id }])
    assert.deepStrictEqual(await t.call('getRefreshToken', { serverConnectionConfigId: cfg.id }), { refreshToken: 'ref' })
    assert.deepStrictEqual(await t.call('getAccessToken', { serverConnectionConfigId: cfg.id }), { token: 'tok' })
  },
  async 'an existing connection: saved only when something changed, token refresh kept secure'() {
    const t = setup()
    const first = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u1', username: 'sam', version: '2.30.0', token: 'tok', address: 'https://abs.example' })
    const writes = []
    const again = await t.call('setCurrentServerConnectionConfig', { id: first.id, userId: 'u1', username: 'sam', version: '2.30.0', token: 'tok2', refreshToken: 'new', address: 'ignored' })
    assert.strictEqual(again.token, 'tok2')
    assert.strictEqual(again.address, 'https://abs.example')
    assert.strictEqual(t.secure[first.id], 'new')
    assert.strictEqual(t.get('device', 'data').serverConnectionConfigs.length, 1)
    assert.ok(writes.length === 0)
  },
  async 'logout and removing the current connection tell native there is none'() {
    const t = setup()
    const cfg = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'sam', version: '1', token: 't', refreshToken: 'r', address: 'https://s' })
    t.deviceCalls.length = 0
    await t.call('logout')
    assert.strictEqual(t.get('device', 'data').lastServerConnectionConfigId, null)
    assert.deepStrictEqual(t.deviceCalls, [{ currentServerId: null }])
    await t.call('setCurrentServerConnectionConfig', { id: cfg.id, userId: 'u', username: 'sam', version: '1', token: 't', address: 'https://s' })
    t.deviceCalls.length = 0
    await t.call('removeServerConnectionConfig', { serverConnectionConfigId: cfg.id })
    assert.deepStrictEqual(t.get('device', 'data').serverConnectionConfigs, [])
    assert.strictEqual(t.secure[cfg.id], undefined)
    assert.deepStrictEqual(t.deviceCalls, [{ currentServerId: null }])
  },
  async 'removing a connection that is not current leaves native alone'() {
    const t = setup()
    const a = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'a', version: '1', token: 't', address: 'https://s' })
    const b = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'b', version: '1', token: 't', address: 'https://s' })
    t.deviceCalls.length = 0
    await t.call('removeServerConnectionConfig', { serverConnectionConfigId: a.id })
    assert.deepStrictEqual(t.deviceCalls, [{}])
    assert.strictEqual(t.get('device', 'data').lastServerConnectionConfigId, b.id)
  },
  async 'settings: saved with defaults for gaps, native told'() {
    const t = setup()
    const out = await t.call('updateDeviceSettings', { ...rules.defaultDeviceSettings(), jumpBackwardsTime: 15, languageCode: null })
    assert.strictEqual(out.deviceSettings.jumpBackwardsTime, 15)
    assert.strictEqual(out.deviceSettings.languageCode, 'en-us')
    assert.deepStrictEqual(t.deviceCalls, [{ settingsChanged: true }])
  },
  async 'local items: lookups'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    t.put('localLibraryItems', 'l2', { ...book('l2'), mediaType: 'podcast', media: { episodes: [] } })
    assert.strictEqual((await t.call('getLocalLibraryItems', {})).value.length, 2)
    assert.strictEqual((await t.call('getLocalLibraryItems', { mediaType: 'podcast' })).value.length, 1)
    assert.strictEqual((await t.call('getLocalLibraryItem', { id: 'l1' })).id, 'l1')
    assert.strictEqual((await t.call('getLocalLibraryItemByLId', { libraryItemId: 'li-l2' })).id, 'l2')
    assert.strictEqual((await t.call('getLocalLibraryItemsInFolder', { folderId: 'f1' })).value.length, 2)
  },
  async 'not found answers nothing (undefined), as the native plugin call.resolve() did, never {}'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    t.put('localFolders', 'f1', { id: 'f1', name: 'Folder' })
    assert.strictEqual(await t.call('getLocalFolder', { folderId: 'nope' }), undefined)
    assert.strictEqual(await t.call('getLocalLibraryItem', { id: 'nope' }), undefined)
    assert.strictEqual(await t.call('getLocalLibraryItemByLId', { libraryItemId: 'li-nope' }), undefined)
    assert.strictEqual(await t.call('getMediaItemHistory', { mediaId: 'li-nope' }), undefined)
    assert.strictEqual(await t.call('getLocalMediaProgressForServerItem', { libraryItemId: 'li-nope', episodeId: '' }), undefined)
    assert.strictEqual(await t.call('getRefreshToken', { serverConnectionConfigId: 'nope' }), undefined)
    assert.strictEqual(await t.call('removeLocalMediaProgress', { localMediaProgressId: 'nope' }), undefined)
    assert.strictEqual((await t.call('getLocalFolder', { folderId: 'f1' })).name, 'Folder')
  },
  async 'track order: renumbered from 1 in the order given, saved only on change'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    assert.strictEqual(await t.call('updateLocalTrackOrder', { localLibraryItemId: 'l1', tracks: [{ localFileId: 'l1a' }, { localFileId: 'l1b' }] }), undefined)
    const out = await t.call('updateLocalTrackOrder', { localLibraryItemId: 'l1', tracks: [{ localFileId: 'l1b' }, { localFileId: 'l1a' }] })
    assert.deepStrictEqual(out.media.tracks.map((x) => [x.localFileId, x.index]), [['l1a', 2], ['l1b', 1]])
    assert.strictEqual(t.get('localLibraryItems', 'l1').media.tracks[0].index, 2)
  },
  async 'ebook progress: created from the item, then updated'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    assert.deepStrictEqual(await t.call('updateLocalEbookProgress', { localLibraryItemId: 'nope', ebookLocation: 'c', ebookProgress: 0.1 }), { error: 'Library Item not found' })
    const made = await t.call('updateLocalEbookProgress', { localLibraryItemId: 'l1', ebookLocation: 'cfi1', ebookProgress: 0.2 })
    assert.strictEqual(made.localMediaProgress.duration, 100)
    assert.strictEqual(made.localMediaProgress.libraryItemId, 'li-l1')
    assert.strictEqual(made.localMediaProgress.ebookLocation, 'cfi1')
    t.tick(5000)
    const upd = await t.call('updateLocalEbookProgress', { localLibraryItemId: 'l1', ebookLocation: 'cfi2', ebookProgress: 0.3 })
    assert.strictEqual(upd.localMediaProgress.ebookProgress, 0.3)
    assert.strictEqual(upd.localMediaProgress.lastUpdate, t.now())
  },
  async 'setLocalMediaProgressFinished: creates the book progress finished, then toggles it back'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    const made = (await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'l1', localEpisodeId: '', isFinished: true })).localMediaProgress
    assert.strictEqual(made.id, 'l1'); assert.strictEqual(made.isFinished, true); assert.strictEqual(made.progress, 1)
    assert.strictEqual(made.duration, 100); assert.strictEqual(made.finishedAt, t.now()); assert.strictEqual(made.startedAt, t.now())
    assert.strictEqual(made.serverConnectionConfigId, 'cfg'); assert.strictEqual(made.libraryItemId, 'li-l1')
    t.tick(1000)
    const back = (await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'l1', isFinished: false })).localMediaProgress
    assert.strictEqual(back.isFinished, false); assert.strictEqual(back.progress, 0); assert.strictEqual(back.finishedAt, null)
    assert.strictEqual(t.get('localMediaProgress', 'l1').isFinished, false)
  },
  async 'setLocalMediaProgressFinished: a podcast episode takes its duration and server episode id; the rule errors are answered'() {
    const t = setup()
    const pod = book('p1', { mediaType: 'podcast', media: { duration: 0, episodes: [{ id: 'e1', duration: 30, serverEpisodeId: 'se-1' }] } })
    t.put('localLibraryItems', 'p1', pod)
    const r = (await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'p1', localEpisodeId: 'e1', isFinished: true })).localMediaProgress
    assert.strictEqual(r.id, 'p1-e1'); assert.strictEqual(r.duration, 30); assert.strictEqual(r.episodeId, 'se-1')
    assert.deepStrictEqual(await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'p1', localEpisodeId: 'nope', isFinished: true }), { error: 'Podcast episode not found' })
    assert.deepStrictEqual(await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'nope', isFinished: true }), { error: 'Library Item not found' })
    assert.deepStrictEqual(await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'l9', localEpisodeId: 'e1', isFinished: true }), { error: 'Library Item not found' })
    t.put('localLibraryItems', 'l2', book('l2'))
    assert.deepStrictEqual(await t.call('setLocalMediaProgressFinished', { localLibraryItemId: 'l2', localEpisodeId: 'e1', isFinished: true }), { error: 'Invalid library item not a podcast' })
  },
  async 'a server progress by web socket: creates for a local item, updates existing with a history event'() {
    const t = setup()
    t.put('localLibraryItems', 'l1', book('l1'))
    const server = { libraryItemId: 'li-l1', duration: 100, progress: 0.5, currentTime: 50, isFinished: false, ebookLocation: null, ebookProgress: null, lastUpdate: 5, startedAt: 1, finishedAt: null, episodeId: null }
    assert.strictEqual(await t.call('syncServerMediaProgressWithLocalMediaProgress', { mediaProgress: server, localLibraryItemId: 'nope' }), undefined)
    assert.strictEqual(await t.call('syncServerMediaProgressWithLocalMediaProgress', { mediaProgress: server, localMediaProgressId: 'nope' }), undefined)
    const created = await t.call('syncServerMediaProgressWithLocalMediaProgress', { mediaProgress: server, localLibraryItemId: 'l1' })
    assert.strictEqual(created.id, 'l1')
    assert.strictEqual(created.currentTime, 50)
    t.put('mediaItemHistory', 'li-l1', { id: 'li-l1', events: [] })
    const updated = await t.call('syncServerMediaProgressWithLocalMediaProgress', { mediaProgress: { ...server, currentTime: 70, progress: 0.7, lastUpdate: 9 }, localLibraryItemId: 'l1', localMediaProgressId: 'l1' })
    assert.strictEqual(updated.currentTime, 70)
    assert.strictEqual(updated.lastUpdate, 9)
    const history = t.get('mediaItemHistory', 'li-l1')
    assert.strictEqual(history.events.length, 1)
    assert.strictEqual(history.events[0].description, 'Received from webhook event')
    assert.strictEqual(history.events[0].type, 'Sync')
    assert.strictEqual(t.ui[0][0], 'onMediaItemHistoryUpdated')
  },
  async 'progress for a server item: episode "" means any'() {
    const t = setup()
    t.put('localMediaProgress', 'local_a', { id: 'local_a', libraryItemId: 'li', episodeId: null })
    t.put('localMediaProgress', 'local_b-e1', { id: 'local_b-e1', libraryItemId: 'li2', episodeId: 'e1' })
    assert.strictEqual((await t.call('getLocalMediaProgressForServerItem', { libraryItemId: 'li', episodeId: '' })).id, 'local_a')
    assert.strictEqual((await t.call('getLocalMediaProgressForServerItem', { libraryItemId: 'li2', episodeId: 'e1' })).id, 'local_b-e1')
    assert.strictEqual(await t.call('getLocalMediaProgressForServerItem', { libraryItemId: 'li2', episodeId: 'e9' }), undefined)
  },
  async 'cleanup: stale progress, missing files, local-only items and old logs'() {
    const t = setup({ existing: { '/x/b.mp3': false, 'content://a': true, 'file:///b': true } })
    t.put('localLibraryItems', 'l1', book('l1'))
    t.put('localLibraryItems', 'gone-link', book('gone-link', { serverConnectionConfigId: null }))
    t.put('localLibraryItems', 'pod', { ...book('pod'), mediaType: 'podcast', media: { episodes: [{ id: 'e1', audioTrack: { localFileId: 'poda' } }, { id: 'e2', audioTrack: null }] } })
    t.put('localMediaProgress', 'local_l1', { id: 'local_l1', localLibraryItemId: 'l1' })
    t.put('localMediaProgress', 'bad', { id: 'bad', localLibraryItemId: 'l1' })
    t.put('localMediaProgress', 'local_orphan', { id: 'local_orphan', localLibraryItemId: 'missing' })
    t.put('localMediaProgress', 'local_pod', { id: 'local_pod', localLibraryItemId: 'pod', localEpisodeId: null })
    t.put('localMediaProgress', 'local_pod-e2', { id: 'local_pod-e2', localLibraryItemId: 'pod', localEpisodeId: 'e2' })
    t.put('localMediaProgress', 'local_pod-e9', { id: 'local_pod-e9', localLibraryItemId: 'pod', localEpisodeId: 'e9' })
    t.put('log', 'old', { id: 'old', timestamp: t.now() - 49 * 3600000 })
    t.put('log', 'new', { id: 'new', timestamp: t.now() - 47 * 3600000 })
    const r = await t.call('cleanup', {})
    assert.deepStrictEqual(Object.keys(t.data.localMediaProgress).sort(), ['local_l1', 'local_pod-e2'])
    assert.strictEqual(t.get('localLibraryItems', 'gone-link'), null)
    assert.strictEqual(r.itemsRemoved, 1)
    const l1 = t.get('localLibraryItems', 'l1')
    assert.deepStrictEqual(l1.localFiles.map((f) => f.id), ['l1a'])
    assert.deepStrictEqual(l1.media.tracks.map((x) => x.localFileId), ['l1a'])
    assert.deepStrictEqual(Object.keys(t.data.log), ['new'])
    // the episode with no audio track goes (its progress was kept: progress is judged before the items are cleaned)
    assert.deepStrictEqual(t.get('localLibraryItems', 'pod').media.episodes.map((e) => e.id), ['e1'])
  },
  async 'cleanup: a cover whose file is gone is dropped'() {
    const t = setup({ existing: { 'content://a': false } })
    t.put('localLibraryItems', 'l1', book('l1', { coverAbsolutePath: '/x/a.mp3', coverContentUrl: 'content://a' }))
    await t.call('cleanup', {})
    const item = t.get('localLibraryItems', 'l1')
    assert.strictEqual(item.coverAbsolutePath, null)
    assert.strictEqual(item.coverContentUrl, null)
  },
  async 'finished rules'() {
    const base = { progress: 0.4, currentTime: 40, isFinished: false, lastUpdate: 1, finishedAt: null }
    const done = rules.applyIsFinished(base, true, 99)
    assert.deepStrictEqual([done.progress, done.currentTime, done.isFinished, done.lastUpdate, done.finishedAt], [1, 0, true, 99, 99])
    const undone = rules.applyIsFinished(done, false, 120)
    assert.deepStrictEqual([undone.progress, undone.isFinished, undone.finishedAt], [0, false, null])
    const same = rules.applyIsFinished({ ...base, isFinished: true, progress: 1 }, true, 5)
    assert.strictEqual(same.progress, 1)
  },
  async 'writes are serialised: concurrent settings updates are not lost'() {
    const t = setup()
    await Promise.all([
      t.call('updateDeviceSettings', { ...rules.defaultDeviceSettings(), jumpBackwardsTime: 20 }),
      t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'sam', version: '1', token: 't', address: 'https://s' })
    ])
    const device = t.get('device', 'data')
    assert.strictEqual(device.deviceSettings.jumpBackwardsTime, 20)
    assert.strictEqual(device.serverConnectionConfigs.length, 1)
  },
  async 'UI mirror: off by default, nothing is sent to the UI for a device write'() {
    const t = setup()
    assert.strictEqual(await t.mod.start(), false)
    assert.deepStrictEqual(await t.call('mirrorSwitch'), { coreUi: false })
    await t.call('updateDeviceSettings', { ...rules.defaultDeviceSettings(), jumpBackwardsTime: 25 })
    await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'sam', version: '1', token: 't', address: 'https://s' })
    assert.deepStrictEqual(t.ui, [], 'with the switch off the UI is told nothing')
  },
  async 'UI mirror: on, every device write is sent to the UI with the saved data'() {
    const t = setup({ coreUi: true })
    assert.strictEqual(await t.mod.start(), true)
    assert.deepStrictEqual(await t.call('mirrorSwitch'), { coreUi: true })
    await t.call('updateDeviceSettings', { ...rules.defaultDeviceSettings(), jumpBackwardsTime: 25 })
    const cfg = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'sam', version: '1', token: 't', address: 'https://s' })
    await t.call('logout')
    const mirrored = t.ui.filter(([e]) => e === 'deviceChanged').map(([, d]) => d.deviceData)
    assert.strictEqual(mirrored.length, 3, 'one event per save')
    assert.strictEqual(mirrored[0].deviceSettings.jumpBackwardsTime, 25)
    assert.strictEqual(mirrored[1].lastServerConnectionConfigId, cfg.id)
    assert.strictEqual(mirrored[1].serverConnectionConfigs.length, 1)
    assert.strictEqual(mirrored[2].lastServerConnectionConfigId, null, 'the sign-out is seen by the UI')
    assert.deepStrictEqual(mirrored[2], t.get('device', 'data'), 'the UI gets exactly what was saved')
  },
  async 'UI mirror: a refused refresh that signs out the current server reaches the UI as a device change too'() {
    const t = setup({ coreUi: true })
    await t.mod.start()
    const cfg = await t.call('setCurrentServerConnectionConfig', { id: null, userId: 'u', username: 'sam', version: '1', token: 't', address: 'https://s' })
    t.ui.length = 0
    await t.call('clearSession', { serverConnectionConfigId: cfg.id })
    assert.deepStrictEqual(t.ui.map(([e]) => e), ['deviceChanged', 'onTokenRefreshFailure'])
    assert.strictEqual(t.ui[0][1].deviceData.lastServerConnectionConfigId, null)
  },
  async 'base64 id matches Android URL_SAFE'() {
    assert.strictEqual(rules.base64Id('a?b>c@d', (s) => Buffer.from(s, 'binary').toString('base64')), 'YT9iPmNAZA==')
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
