/**
 * Progress calls to the server, from the core (moved from ApiHandler: sendProgressSync, sendLocalProgressSync, updateMediaProgress,
 * closePlaybackSession and getMediaProgress). Served as `progress.<name>`. Each takes the server the caller names
 * (`address`, `token`, `serverConnectionConfigId`, as api.request) and answers what the Kotlin callers always got:
 *  - sendSession({sessionId, syncData})       -> {} or {error}
 *  - sendLocalSession({session})               -> {} or {error}   (session: the PlaybackSession JSON, deviceInfo included)
 *  - updateMedia({libraryItemId, episodeId, updatePayload}) -> {} or {error}   (PATCH)
 *  - closeSession({playbackSessionId})         -> {} or {error}   (POST with an empty body, as before)
 *  - getMedia({libraryItemId, episodeId})      -> the MediaProgress JSON, or {error}; 3 s timeout, the answer is wanted quickly
 * Retries, the token refresh and the timeouts are api.js's and this module's decisions, not native's.
 */
import * as rules from './dbRules'

/** The endpoint of one item's progress; an empty episode id means the book (the server's rule) */
export function progressEndpoint(libraryItemId, episodeId) {
  return episodeId ? `/api/me/progress/${libraryItemId}/${episodeId}` : `/api/me/progress/${libraryItemId}`
}

export function progressModule(bridge, { api }) {
  const GET_PROGRESS_TIMEOUT = 3000
  const server = (a) => ({ address: a.address, token: a.token, serverConnectionConfigId: a.serverConnectionConfigId })
  const outcome = (r) => (r.error ? { error: r.error } : {})

  async function sendSession(a) {
    return outcome(await api.request({ method: 'POST', endpoint: `/api/session/${a.sessionId}/sync`, payload: a.syncData, ...server(a) }))
  }

  async function sendLocalSession(a) {
    const session = a.session || {}
    const payload = { ...rules.partialPlaybackSession(session), deviceInfo: session.deviceInfo }
    return outcome(await api.request({ method: 'POST', endpoint: '/api/session/local', payload, ...server(a) }))
  }

  async function updateMedia(a) {
    const endpoint = progressEndpoint(a.libraryItemId, a.episodeId)
    return outcome(await api.request({ method: 'PATCH', endpoint, payload: a.updatePayload, ...server(a) }))
  }

  async function closeSession(a) {
    return outcome(await api.request({ method: 'POST', endpoint: `/api/session/${a.playbackSessionId}/close`, payload: {}, ...server(a) }))
  }

  async function getMedia(a) {
    const endpoint = progressEndpoint(a.libraryItemId, a.episodeId)
    return api.request({ method: 'GET', endpoint, timeoutMs: GET_PROGRESS_TIMEOUT, ...server(a) })
  }

  bridge.serve('core', 'progress.sendSession', (a) => sendSession(a || {}))
  bridge.serve('core', 'progress.sendLocalSession', (a) => sendLocalSession(a || {}))
  bridge.serve('core', 'progress.updateMedia', (a) => updateMedia(a || {}))
  bridge.serve('core', 'progress.closeSession', (a) => closeSession(a || {}))
  bridge.serve('core', 'progress.getMedia', (a) => getMedia(a || {}))

  return { sendSession, sendLocalSession, updateMedia, closeSession, getMedia }
}
