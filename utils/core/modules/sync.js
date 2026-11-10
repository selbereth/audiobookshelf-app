/**
 * Syncing the local data with the server when the app connects (moved from ApiHandler.syncLocalMediaProgressForUser and
 * sendSyncLocalSessions, and AbsDatabase.syncLocalSessionsWithServer). Served as `sync.syncLocalSessionsWithServer` -> {} or {error}.
 */
import * as rules from './dbRules'

const C = rules.COLLECTIONS

export function syncModule(bridge, { log = console.log, db, api }) {
  const same = (a, b) => (a ?? null) === (b ?? null)

  async function currentConfig() {
    const data = await db.methods.getDeviceData()
    return data.serverConnectionConfigs.find((c) => c.id === data.lastServerConnectionConfigId) || null
  }
  const call = (config, args) => api.request({ address: config.address, token: config.token, serverConnectionConfigId: config.id, ...args })

  /** Local progress newer than the server's stays (ebook position is sent up), a newer server progress replaces the local one */
  async function syncLocalMediaProgress(config) {
    log('sync: syncLocalMediaProgressForUser: Server connection ' + config.name)
    const all = (await db.store.list(C.localMediaProgress)).filter((p) => p.serverConnectionConfigId === config.id)
    if (!all.length) return log('sync: No local media progress to sync')
    log('sync: Found ' + all.length + ' local media progress')
    const user = await call(config, { endpoint: '/api/me' })
    if (user.error) return log('sync: Failed to load user from server (' + config.name + ')')
    let upToDate = 0
    let updated = 0
    for (const server of user.mediaProgress || []) {
      const local = all.find((l) => (l.episodeId != null ? l.libraryItemId === server.libraryItemId && l.episodeId === server.episodeId : l.libraryItemId === server.libraryItemId))
      if (!local) continue
      // A row without lastUpdate cannot be compared: it is neither applied nor counted as up to date (Kotlin: lastUpdate is a required Long, so the whole user answer failed to parse)
      if (typeof server.lastUpdate !== 'number') {
        log(`sync: server progress for item "${rules.mediaItemIdOf(server)}" has no lastUpdate, skipped`)
        continue
      }
      if (server.lastUpdate > local.lastUpdate) {
        const logs = []
        if (!same(server.progress, local.progress)) logs.push(`Updated progress from ${local.progress} to ${server.progress}`)
        if (!same(server.currentTime, local.currentTime)) logs.push(`Updated currentTime from ${local.currentTime} to ${server.currentTime}`)
        if (!same(server.isFinished, local.isFinished)) logs.push(`Updated isFinished from ${local.isFinished} to ${server.isFinished}`)
        if (!same(server.ebookProgress, local.ebookProgress)) logs.push(`Updated ebookProgress from ${local.ebookProgress} to ${server.ebookProgress}`)
        if (logs.length) log(`sync: Server progress for item "${rules.mediaItemIdOf(server)}" is more recent than local (server lastUpdate=${server.lastUpdate}, local lastUpdate=${local.lastUpdate}). ${logs.join(', ')}`)
        await db.serial(async () => {
          if (logs.length) await db.addSyncEvent(server, 'Sync on server connection')
          const next = rules.applyServerProgress(local, server)
          await db.store.put(C.localMediaProgress, next.id, next)
        })
        updated++
      } else if (local.lastUpdate > server.lastUpdate && local.ebookLocation != null && local.ebookLocation !== server.ebookLocation) {
        log(`sync: Local progress for ebook item "${rules.mediaItemIdOf(server)}" is more recent than the server's, sending ebook progress`)
        const r = await call(config, { method: 'PATCH', endpoint: '/api/me/progress/' + local.libraryItemId, payload: { ebookLocation: local.ebookLocation, ebookProgress: local.ebookProgress, lastUpdate: local.lastUpdate } })
        if (!r.error) log(`sync: Updated server ebook progress for item "${rules.mediaItemIdOf(server)}"`)
      } else {
        upToDate++
      }
    }
    log(`sync: Finished syncing local media progress with server. ${upToDate} up-to-date, ${updated} updated`)
  }

  /** Sends the sessions that were saved while offline. Returns an error text or null */
  async function sendSyncLocalSessions(config, sessions) {
    const info = await bridge.call('system', 'deviceInfo', {})
    const deviceInfo = { deviceId: info.deviceId, manufacturer: info.manufacturer, model: info.model, sdkVersion: info.sdk, clientVersion: info.versionName }
    log(`sync: Sending ${sessions.length} saved local playback sessions to server (${config.name})`)
    const r = await call(config, { method: 'POST', endpoint: '/api/session/local-all', payload: { sessions: sessions.map(rules.partialPlaybackSession), deviceInfo } })
    if (r.error) {
      log('sync: Failed to sync local sessions. (' + r.error + ')')
      return r.error
    }
    for (const result of r.results || []) {
      const session = sessions.find((s) => s.id === result.id)
      if (!session) continue
      if (result.progressSynced === true) {
        await db.serial(() => db.addPlaybackEvent('Save', session, { serverSyncAttempted: true, serverSyncSuccess: true, serverSyncMessage: 'Progress synced on server' }))
        log(`sync: Synced session "${session.displayTitle}" with server, server progress was updated for item ${rules.sessionMediaItemId(session)}`)
      } else if (!result.success) {
        log(`sync: Failed to sync session "${session.displayTitle}" with server. Error: ${result.error}`)
      } else {
        log(`sync: Synced session "${session.displayTitle}" with server. Server progress was up-to-date for item ${rules.sessionMediaItemId(session)}`)
      }
    }
    return null
  }

  async function syncLocalSessionsWithServer() {
    const config = await currentConfig()
    if (!config) {
      log('sync: syncLocalSessionsWithServer: not connected to server')
      return {}
    }
    await syncLocalMediaProgress(config)
    const saved = (await db.store.list(C.playbackSession)).filter((s) => s.serverConnectionConfigId === config.id)
    if (!saved.length) {
      log('sync: No saved local playback sessions to send to server.')
      return {}
    }
    const error = await sendSyncLocalSessions(config, saved)
    if (error) return { error }
    log(`sync: Finished sending local playback sessions to server. Removing ${saved.length} saved sessions.`)
    for (const s of saved) await db.store.delete(C.playbackSession, s.id)
    return {}
  }

  bridge.serve('core', 'sync.syncLocalSessionsWithServer', () => syncLocalSessionsWithServer())
  return { syncLocalSessionsWithServer, syncLocalMediaProgress, sendSyncLocalSessions }
}
