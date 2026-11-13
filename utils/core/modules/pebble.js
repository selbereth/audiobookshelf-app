/**
 * The Pebble watch in the core (Phase 7, switch corePebble). The watch's logic is utils/pebble/hub.js (shared with iOS): what the
 * watch shows, which commands it sends and how each is answered. This module runs it in the core and supplies its primitives:
 * the core's own api and db, the server.playItem call, and the `player` and `pebble` connectors, which only report facts and
 * move values. The decisions Kotlin made in AudioPrimitives.kt and PebblePrimitives.kt are here; their tests quote the lines.
 *
 * Native calls `pebble` / `run` {method, args} (CoreHost.callUp) for each watch message and Pebble app event.
 */
import { createHub } from '../../pebble/hub'
import * as rules from './dbRules'
import { progressEndpoint } from './progress'

const C = rules.COLLECTIONS
/** The server answer for the progress before a downloaded book starts: past this the local progress is used */
export const SERVER_CHECK_TIMEOUT_MS = 4000

export const WAIT_SECONDS = 20
export const NUDGE_LIMIT = 3
const ENTRY = ['handle', 'opened', 'closed', 'status', 'startPlaying', 'awaitPlaying']

/** AudioPrimitives.kt awaitPlaying: nudge the player to play at seconds 2, 5, 8 ..., three times at most */
export function shouldNudge(second, nudges) {
  return second >= 2 && second % 3 === 2 && nudges < NUDGE_LIMIT
}

/** AudioPrimitives.kt playPause: a book whose loading failed (player idle) or none loaded is loaded again */
export function needsReload(state) {
  return !state.loaded || !!state.idle
}

/** AudioPrimitives.kt startAudio: the book's own server connection, else the last one used; null when there is none */
export function pickServerConfig(deviceData, serverConnectionConfigId) {
  const configs = deviceData.serverConnectionConfigs || []
  return configs.find((c) => c.id === serverConnectionConfigId) || configs.find((c) => c.id === deviceData.lastServerConnectionConfigId) || null
}

/** AudioPrimitives.kt state(): what the watch shows of a session (title, duration, chapters) */
export function sessionOf(s) {
  return { title: s.displayTitle || '', duration: s.duration || 0, chapters: (s.chapters || []).map((c) => ({ title: c.title, start: c.start, end: c.end })) }
}

export function pebbleModule(bridge, { api, server, db, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const player = (method, args = {}) => bridge.call('player', method, args)
  const pebble = (method, args = {}) => bridge.call('pebble', method, args)
  const deviceData = () => db.methods.getDeviceData({})
  const localItemOf = async (id) => {
    if (!id) return null
    const item = await db.methods.getLocalLibraryItem({ id })
    return item && item.id ? item : null
  }
  const bound = async () => (await player('bind')).live === true
  const playerState = () => player('getState')

  /** Resolves with the answer, or {error} when it is not there within SERVER_CHECK_TIMEOUT_MS */
  function withDeadline(promise) {
    let timer
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'no answer in time' }), SERVER_CHECK_TIMEOUT_MS) })
    return Promise.race([promise, late]).then((v) => { clearTimeout(timer); return v })
  }

  /**
   * Before a downloaded book starts: the server's progress for it is written to the local progress when it is newer (the rule of
   * sync.js syncLocalMediaProgress: a newer lastUpdate wins), so the session built from the local progress starts there. Never
   * blocks or fails the start: when the server cannot be asked, the local progress is used as it is.
   */
  async function useNewerServerProgress(localItemId, localEpisodeId) {
    const couldNot = (why) => log('Pebble start: could not check the server (' + why + '), using local progress')
    try {
      const item = await localItemOf(localItemId)
      if (!item || !item.libraryItemId) return couldNot('not linked to a server')
      const config = ((await deviceData()).serverConnectionConfigs || []).find((c) => c.id === item.serverConnectionConfigId)
      if (!config) return couldNot('not logged in to its server')
      if (!(await bridge.call('system', 'network')).connected) return couldNot('offline')
      const episode = localEpisodeId ? ((item.media && item.media.episodes) || []).find((e) => e.id === localEpisodeId) : null
      const episodeId = (episode && episode.serverEpisodeId) || null
      const id = rules.localMediaProgressId(item.id, localEpisodeId || null)
      const local = await db.store.get(C.localMediaProgress, id)
      const server = await withDeadline(api.request({
        method: 'GET',
        endpoint: progressEndpoint(item.libraryItemId, episodeId),
        timeoutMs: SERVER_CHECK_TIMEOUT_MS,
        address: config.address,
        token: config.token,
        serverConnectionConfigId: config.id
      }))
      if (!server || server.error) return couldNot((server && server.error) || 'no answer')
      if (typeof server.lastUpdate !== 'number') return couldNot('the answer has no lastUpdate')
      const localUpdate = (local && local.lastUpdate) || 0
      if (!(server.lastUpdate > localUpdate)) return log('Pebble start: local progress is current')
      log(`Pebble start: server progress is newer (${server.lastUpdate} vs ${localUpdate}), using it`)
      if (local) {
        // The startup sync's write (sync.js): the sync history, then the server progress applied to the local row
        await db.serial(async () => {
          await db.addSyncEvent(server, 'Sync on server connection')
          await db.store.put(C.localMediaProgress, local.id, rules.applyServerProgress(local, server))
        })
      } else {
        await db.methods.syncServerMediaProgressWithLocalMediaProgress({ mediaProgress: server, localLibraryItemId: item.id, localEpisodeId: localEpisodeId || '', localMediaProgressId: '' })
      }
    } catch (e) {
      couldNot(e && e.message ? e.message : 'failed')
    }
  }

  /** AudioPrimitives.kt startAudio: from the download when there is one, else from the server */
  async function startAudio({ title, localItemId, localEpisodeId, libraryItemId, episodeId, serverConnectionConfigId }) {
    const playbackRate = await pebble('savedRate')
    if (localItemId) {
      await useNewerServerProgress(localItemId, localEpisodeId)
      const r = await player('loadLocal', { localLibraryItemId: localItemId, localEpisodeId: localEpisodeId || '', playbackRate })
      if (r.ok) return { loading: true, title }
      return { error: r.reason === 'tracks' ? 'Audio files are missing: download the book again' : 'Open Audiobookshelf on the phone' }
    }
    if (!libraryItemId) return { error: 'Open Audiobookshelf on the phone' }
    const config = pickServerConfig(await deviceData(), serverConnectionConfigId)
    if (!config) return { error: 'Log in to the server in the app first' }
    const payload = await player('playItemPayload')
    const session = await server.playItem({
      address: config.address,
      token: config.token,
      serverConnectionConfigId: config.id,
      libraryItemId,
      episodeId: episodeId || undefined,
      payload
    })
    if (!session || session.error) return { error: 'Could not reach the server' }
    const r = await player('loadSession', { session, playbackRate })
    if (r.ok) return { loading: true, title }
    return { error: 'Open Audiobookshelf on the phone' }
  }

  const native = {
    audio: {
      async state() {
        const p = await playerState()
        const last = (await deviceData()).lastPlaybackSession || null
        const speed = await pebble('savedRate')
        const lastUpdatedAt = (last && last.updatedAt) || 0
        if (p.live && p.loaded) return { live: true, speed, lastUpdatedAt, playing: !!p.lazyPlaying, time: p.positionSec, session: sessionOf(p.session) }
        return { live: !!p.live, speed, lastUpdatedAt, playing: false, time: last ? last.currentTime || 0 : 0, session: last ? sessionOf(last) : null }
      },
      async playPause() {
        if (!(await bound())) return { error: 'Open Audiobookshelf on the phone' }
        if (!needsReload(await playerState())) {
          await player('playPause')
          return {}
        }
        const last = (await deviceData()).lastPlaybackSession
        if (!last) return { error: 'Play a book in Selbershelf on the phone first' }
        const local = await localItemOf(last.localLibraryItem && last.localLibraryItem.id)
        return startAudio({
          title: last.displayTitle || '',
          localItemId: local && local.id,
          localEpisodeId: last.localEpisodeId,
          libraryItemId: last.libraryItemId,
          episodeId: last.episodeId,
          serverConnectionConfigId: last.serverConnectionConfigId
        })
      },
      pause: () => player('pauseService'),
      async jump(forward) {
        const s = await playerState()
        if (s.live && s.loaded) await player('jump', { forward: !!forward })
      },
      async setSpeed(speed) {
        if (await bound()) await player('setSpeed', { speed })
      },
      async start({ libraryItemId, localLibraryItemId }) {
        if (!(await bound())) return { error: 'Open Audiobookshelf on the phone' }
        const local = await localItemOf(localLibraryItemId)
        return startAudio({ title: '', localItemId: local && local.id, libraryItemId, episodeId: null, serverConnectionConfigId: null })
      },
      /** AudioPrimitives.kt awaitPlaying: wait up to WAIT_SECONDS for the book to really play, nudging it when it is loaded but silent */
      async awaitPlaying() {
        let nudges = 0
        for (let second = 0; second < WAIT_SECONDS; second++) {
          await sleep(1000)
          const s = await playerState()
          if (s.live && s.loaded) {
            if (s.lazyPlaying) return { playing: true }
            if (shouldNudge(second, nudges)) {
              nudges++
              log('Book is loaded but not playing, asking it to play (attempt ' + nudges + ')')
              await player('playService')
            }
          }
        }
        return { playing: false }
      }
    },
    tts: {
      state: () => pebble('tts.state'),
      playPause: () => pebble('tts.playPause'),
      pause: () => pebble('tts.pause'),
      skip: (forward) => pebble('tts.skip', { forward }),
      setRate: (rate) => pebble('tts.setRate', { rate }),
      resume: (session) => pebble('tts.resume', { session }),
      startNew: (args) => pebble('tts.startNew', args)
    },
    device: {
      volume: () => pebble('device.volume'),
      adjustVolume: (direction) => pebble('device.adjustVolume', { direction })
    },
    api: {
      /** PebblePrimitives.kt get: no server or no connection answers not ok; the token is refreshed by asking for the user first */
      async get(path) {
        const srv = await api.resolveServer({})
        const net = await bridge.call('system', 'network')
        if (!srv || !net.connected) return { ok: false }
        await api.request({ method: 'GET', endpoint: '/api/me', timeoutMs: 15000 })
        const r = await api.request({ method: 'GET', endpoint: path, timeoutMs: 15000 })
        if (r.error) return { ok: false }
        // PebblePrimitives.kt:79: a list answers as a JSON array (the core wraps it as {value})
        const isList = Array.isArray(r.value) && Object.keys(r).length === 1
        return { ok: true, json: isList ? r.value : r }
      },
      lastLibraryId: () => pebble('api.lastLibraryId')
    },
    local: {
      books: () => pebble('local.books'),
      ebookProgress: (id) => pebble('local.ebookProgress', { id })
    },
    pebble: { send: (items) => pebble('pebble.send', { items }) }
  }

  const hub = createHub(native, { log, now })

  /** One watch message or Pebble app event: `method` is a hub entry point */
  async function run(method, args = []) {
    if (!ENTRY.includes(method)) throw new Error('unknown pebble method ' + method)
    if (method === 'closed') {
      hub.closed()
      await player('release')
      return null
    }
    const result = await hub[method](...args)
    return result === undefined ? null : result
  }

  bridge.serve('pebble', 'run', ({ method, args } = {}) => run(method, args || []))

  return { hub, native, run }
}
