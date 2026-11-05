/**
 * The local database in the core. The data is JSON in the `store` connector (collection + key); every rule is in dbRules.js.
 * Served to the UI as `db.<name>` (plugins/capacitor/AbsDatabase.js maps AbsDatabase.<name> to it on Android) with the same
 * arguments and results the AbsDatabase plugin had. Native code that has not moved yet reads the same rows (DbManager).
 *
 * Reads go to the store every time (no copy kept here), writes are serialised, so Kotlin and JS never work from stale data.
 * "Not found" answers {} like the plugin's call.resolve() did.
 */
import * as rules from './dbRules'

const { COLLECTIONS: C } = rules

export function dbModule(bridge, { log = console.log, now = () => Date.now(), emitToUi = () => {}, btoa = globalThis.btoa } = {}) {
  const parse = (s) => JSON.parse(s)

  const store = {
    async get(collection, key) {
      const r = await bridge.call('store', 'get', { collection, key })
      return r && r.value !== null && r.value !== undefined ? parse(r.value) : null
    },
    async list(collection) {
      const r = await bridge.call('store', 'list', { collection })
      return ((r && r.items) || []).map((i) => parse(i.value))
    },
    put: (collection, key, value) => bridge.call('store', 'put', { collection, key, value: JSON.stringify(value) }),
    delete: (collection, key) => bridge.call('store', 'delete', { collection, key })
  }

  // Writes one after the other: a read-modify-write never interleaves with another
  let tail = Promise.resolve()
  const serial = (fn) => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => {})
    return run
  }

  const deviceSync = (args = {}) => bridge.call('device', 'sync', args).catch((e) => log('db: device.sync failed ' + e.message))

  async function readDevice() {
    return rules.normalizeDeviceData(await store.get(C.device, 'data')).data
  }
  const saveDevice = (data) => store.put(C.device, 'data', data)

  const nonEmpty = (v) => (v === undefined || v === null || v === '' ? null : v)
  const methods = {}
  const define = (name, fn, { write = false } = {}) => {
    methods[name] = fn
    bridge.serve('core', 'db.' + name, write ? (args) => serial(() => fn(args || {})) : (args) => fn(args || {}))
  }

  // ---- device data and settings
  define('getDeviceData', () => readDevice())

  define('updateDeviceSettings', async (settings) => {
    const data = await readDevice()
    data.deviceSettings = rules.normalizeDeviceData({ ...data, deviceSettings: settings }).data.deviceSettings
    await saveDevice(data)
    await deviceSync({ settingsChanged: true })
    return data
  }, { write: true })

  // ---- server connections
  define('setCurrentServerConnectionConfig', async (payload) => {
    const data = await readDevice()
    const { id, userId, username, version, token, refreshToken, customHeaders, address } = payload
    let config = data.serverConnectionConfigs.find((c) => c.id === id)
    if (!config) {
      // New server connection
      const newId = rules.base64Id(`${address || ''}@${username}`, btoa)
      if (nonEmpty(refreshToken)) await bridge.call('secure', 'put', { key: newId, value: refreshToken })
      config = {
        id: newId,
        index: data.serverConnectionConfigs.length,
        name: `${address || ''} (${username})`,
        address: address || '',
        version: version ?? null,
        userId,
        username,
        token,
        customHeaders: customHeaders ?? null
      }
      data.serverConnectionConfigs.push(config)
      data.lastServerConnectionConfigId = config.id
      await saveDevice(data)
    } else {
      let save = false
      if (config.username !== username || config.token !== token || config.version !== version) {
        config.userId = userId
        config.username = username
        config.name = `${config.address} (${config.username})`
        config.version = version ?? null
        config.token = token
        save = true
      }
      if (nonEmpty(refreshToken)) await bridge.call('secure', 'put', { key: config.id, value: refreshToken })
      if (data.lastServerConnectionConfigId !== id) {
        data.lastServerConnectionConfigId = id
        save = true
      }
      if (save) await saveDevice(data)
    }
    await deviceSync({ currentServerId: config.id })
    return config
  }, { write: true })

  define('removeServerConnectionConfig', async ({ serverConnectionConfigId }) => {
    await bridge.call('secure', 'delete', { key: serverConnectionConfigId })
    const data = await readDevice()
    const wasCurrent = data.lastServerConnectionConfigId === serverConnectionConfigId
    data.serverConnectionConfigs = data.serverConnectionConfigs.filter((c) => c.id !== serverConnectionConfigId)
    if (wasCurrent) data.lastServerConnectionConfigId = null
    await saveDevice(data)
    await deviceSync(wasCurrent ? { currentServerId: null } : {})
    return {}
  }, { write: true })

  define('getRefreshToken', async ({ serverConnectionConfigId }) => {
    const r = await bridge.call('secure', 'get', { key: serverConnectionConfigId })
    return r && r.value ? { refreshToken: r.value } : {}
  })

  define('clearRefreshToken', async ({ serverConnectionConfigId }) => {
    const r = await bridge.call('secure', 'delete', { key: serverConnectionConfigId })
    return { success: !!(r && r.removed) }
  })

  /**
   * The server gave new tokens (api.js refresh). The refresh token goes to secure storage when it is new, the access token to the
   * saved connection (a queued download can refresh a server that is not the current one). The UI is told only for the current server.
   */
  define('updateTokens', async ({ serverConnectionConfigId, accessToken, refreshToken }) => {
    const stored = await bridge.call('secure', 'get', { key: serverConnectionConfigId })
    if (nonEmpty(refreshToken) && refreshToken !== (stored && stored.value)) await bridge.call('secure', 'put', { key: serverConnectionConfigId, value: refreshToken })
    const data = await readDevice()
    const config = data.serverConnectionConfigs.find((c) => c.id === serverConnectionConfigId)
    const isCurrent = data.lastServerConnectionConfigId === serverConnectionConfigId
    if (config) {
      config.token = accessToken
      await saveDevice(data)
    }
    // Native keeps its own copy of the current connection: refreshing it makes the new access token the one it sends
    await deviceSync(isCurrent ? { currentServerId: serverConnectionConfigId } : {})
    if (isCurrent) emitToUi('onTokenRefresh', { accessToken })
    return {}
  }, { write: true })

  /** The server refused the refresh token for good: forget it, and when that was the current server sign out (the UI goes to login) */
  define('clearSession', async ({ serverConnectionConfigId }) => {
    await bridge.call('secure', 'delete', { key: serverConnectionConfigId })
    const data = await readDevice()
    if (data.lastServerConnectionConfigId !== serverConnectionConfigId) return { current: false }
    data.lastServerConnectionConfigId = null
    await saveDevice(data)
    await deviceSync({ currentServerId: null })
    emitToUi('onTokenRefreshFailure', { error: 'Token refresh failed', serverConnectionConfigId })
    return { current: true }
  }, { write: true })

  define('getAccessToken', async ({ serverConnectionConfigId }) => {
    const data = await readDevice()
    const config = data.serverConnectionConfigs.find((c) => c.id === serverConnectionConfigId)
    return { token: (config && config.token) || '' }
  })

  define('logout', async () => {
    const data = await readDevice()
    data.lastServerConnectionConfigId = null
    await saveDevice(data)
    await deviceSync({ currentServerId: null })
    return {}
  }, { write: true })

  // ---- local folders and library items
  define('getLocalFolders', async () => ({ value: await store.list(C.localFolders) }))
  define('getLocalFolder', async ({ folderId }) => (await store.get(C.localFolders, folderId)) || {})
  define('getLocalLibraryItem', async ({ id }) => (await store.get(C.localLibraryItems, id)) || {})
  define('getLocalLibraryItemByLId', async ({ libraryItemId }) => (await store.list(C.localLibraryItems)).find((i) => i.libraryItemId === libraryItemId) || {})
  define('getLocalLibraryItems', async ({ mediaType }) => {
    const all = await store.list(C.localLibraryItems)
    return { value: mediaType ? all.filter((i) => i.mediaType === mediaType) : all }
  })
  define('getLocalLibraryItemsInFolder', async ({ folderId }) => ({ value: (await store.list(C.localLibraryItems)).filter((i) => i.folderId === folderId) }))

  define('updateLocalTrackOrder', async ({ localLibraryItemId, tracks }) => {
    const item = await store.get(C.localLibraryItems, localLibraryItemId || '')
    if (!item) return {}
    const { changed } = rules.reorderTracks(item, tracks || [])
    if (!changed) return {}
    await store.put(C.localLibraryItems, item.id, item)
    return item
  }, { write: true })

  // ---- local media progress
  define('getAllLocalMediaProgress', async () => ({ value: await store.list(C.localMediaProgress) }))

  define('getLocalMediaProgressForServerItem', async ({ libraryItemId, episodeId }) => {
    const ep = nonEmpty(episodeId)
    return (await store.list(C.localMediaProgress)).find((p) => libraryItemId === p.libraryItemId && (ep === null || p.episodeId === ep)) || {}
  })

  define('removeLocalMediaProgress', async ({ localMediaProgressId }) => {
    await store.delete(C.localMediaProgress, localMediaProgressId)
    return {}
  }, { write: true })

  define('updateLocalEbookProgress', async ({ localLibraryItemId, ebookLocation, ebookProgress }) => {
    const location = ebookLocation ?? ''
    const progressValue = ebookProgress ?? 0
    let progress = await store.get(C.localMediaProgress, localLibraryItemId)
    if (!progress) {
      const item = await store.get(C.localLibraryItems, localLibraryItemId)
      if (!item) return { error: 'Library Item not found' }
      progress = rules.newLocalMediaProgress(item, { id: localLibraryItemId, duration: item.media.duration || 0, ebookLocation: location, ebookProgress: progressValue, lastUpdate: now() })
    } else {
      progress = rules.applyEbookProgress(progress, location, progressValue, now())
    }
    await store.put(C.localMediaProgress, progress.id, progress)
    return { localMediaProgress: progress }
  }, { write: true })

  /** A server progress arrived by web socket: update the matching local progress, or create it for a local item */
  define('syncServerMediaProgressWithLocalMediaProgress', async ({ mediaProgress, localLibraryItemId, localEpisodeId, localMediaProgressId }) => {
    const episode = nonEmpty(localEpisodeId)
    if (!nonEmpty(localMediaProgressId)) {
      const item = await store.get(C.localLibraryItems, localLibraryItemId || '')
      if (!item) {
        log('db: syncServerMediaProgress: local library item not found')
        return {}
      }
      const progress = rules.newLocalMediaProgress(item, {
        id: rules.localMediaProgressId(localLibraryItemId, episode),
        localEpisodeId: episode,
        duration: mediaProgress.duration,
        progress: mediaProgress.progress,
        currentTime: mediaProgress.currentTime,
        isFinished: mediaProgress.isFinished,
        ebookLocation: mediaProgress.ebookLocation ?? null,
        ebookProgress: mediaProgress.ebookProgress ?? null,
        lastUpdate: mediaProgress.lastUpdate,
        startedAt: mediaProgress.startedAt,
        finishedAt: mediaProgress.finishedAt ?? null,
        episodeId: mediaProgress.episodeId ?? null
      })
      await store.put(C.localMediaProgress, progress.id, progress)
      return progress
    }
    const existing = await store.get(C.localMediaProgress, localMediaProgressId)
    if (!existing) {
      log('db: syncServerMediaProgress: local media progress not found ' + localMediaProgressId)
      return {}
    }
    await addSyncEvent(mediaProgress, 'Received from webhook event')
    const updated = rules.applyServerProgress(existing, mediaProgress)
    await store.put(C.localMediaProgress, updated.id, updated)
    return updated
  }, { write: true })

  async function addSyncEvent(mediaProgress, description) {
    const id = rules.mediaItemIdOf(mediaProgress)
    const history = await store.get(C.mediaItemHistory, id)
    if (!history) {
      log('db: addSyncEvent: media item history not created yet for ' + id)
      return
    }
    history.events = history.events || []
    history.events.push(rules.syncEvent(mediaProgress.currentTime, description, now()))
    await store.put(C.mediaItemHistory, id, history)
    emitToUi('onMediaItemHistoryUpdated', history)
  }

  define('getMediaItemHistory', async ({ mediaId }) => (await store.get(C.mediaItemHistory, mediaId || '')) || {})

  // ---- startup and cleanup
  /** Core start: apply defaults for settings an older version did not have, then tell Kotlin to take the new copy */
  define('startup', async () => {
    const { data, changed } = rules.normalizeDeviceData(await store.get(C.device, 'data'))
    if (changed) {
      await saveDevice(data)
      await deviceSync()
    }
    return { changed }
  }, { write: true })

  /** The UI opens: remove progress, local files and logs that no longer have anything behind them (was AbsDatabase.load) */
  define('cleanup', async () => {
    const result = { progressRemoved: 0, itemsChanged: 0, itemsRemoved: 0, logsRemoved: 0 }
    let items = await store.list(C.localLibraryItems)
    for (const id of rules.staleLocalMediaProgressIds(await store.list(C.localMediaProgress), items)) {
      log('db: cleanup: removing local media progress ' + id)
      await store.delete(C.localMediaProgress, id)
      result.progressRemoved++
    }
    for (const item of items) {
      const exists = {}
      for (const f of item.localFiles || []) {
        const r = await bridge.call('files', 'exists', rules.localFileProbe(f))
        exists[f.id] = !!(r && r.exists)
      }
      const out = rules.cleanLocalLibraryItem(item, exists)
      if (out.remove) {
        log('db: cleanup: local only item ' + item.id + ' - removing')
        await store.delete(C.localLibraryItems, item.id)
        result.itemsRemoved++
      } else if (out.changed) {
        log('db: cleanup: saving local library item ' + item.id)
        await store.put(C.localLibraryItems, item.id, out.item)
        result.itemsChanged++
      }
    }
    for (const id of rules.oldLogIds(await store.list(C.log), now())) {
      await store.delete(C.log, id)
      result.logsRemoved++
    }
    return result
  }, { write: true })

  return { methods, store, serial, startup: () => serial(() => methods.startup({})) }
}
