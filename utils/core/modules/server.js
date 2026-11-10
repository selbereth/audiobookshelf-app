/**
 * Server calls that answer a decision, from the core (moved from ApiHandler: pingServer, authorize, playLibraryItem). Served as
 * `server.<name>`. Each takes the server the caller names (`address`, `token`, `serverConnectionConfigId`); without one, the current
 * server is used (api.resolveServer):
 *  - ping({address, token, serverConnectionConfigId})  -> {reachable: true | false}   (GET /ping, 3 s)
 *  - authorize({...})                                  -> {mediaProgress: [...]} or {error}   (the user's progress list)
 *  - playItem({libraryItemId, episodeId, payload, ...}) -> the PlaybackSession JSON with serverConnectionConfigId and
 *    serverAddress of the server that answered, or {error}
 * Retries, the token refresh and the timeouts are api.js's; what each answer means is this module's.
 */
export function serverModule(bridge, { api }) {
  const PING_TIMEOUT = 3000
  const server = (a) => ({ address: a.address, token: a.token, serverConnectionConfigId: a.serverConnectionConfigId })

  async function ping(a) {
    const r = await api.request({ method: 'GET', endpoint: '/ping', timeoutMs: PING_TIMEOUT, anonymous: true, ...server(a) })
    return { reachable: !r.error && !!r.success }
  }

  async function authorize(a) {
    const r = await api.request({ method: 'POST', endpoint: '/api/authorize', payload: {}, ...server(a) })
    if (r.error) return { error: r.error }
    return { mediaProgress: (r.user && r.user.mediaProgress) || [] }
  }

  async function playItem(a) {
    const srv = await api.resolveServer(server(a))
    if (!srv) return { error: 'No server connection' }
    const endpoint = a.episodeId ? `/api/items/${a.libraryItemId}/play/${a.episodeId}` : `/api/items/${a.libraryItemId}/play`
    const r = await api.request({ method: 'POST', endpoint, payload: a.payload || {}, ...srv })
    if (r.error) return { error: r.error }
    return { ...r, serverConnectionConfigId: srv.serverConnectionConfigId, serverAddress: srv.address }
  }

  bridge.serve('core', 'server.ping', (a) => ping(a || {}))
  bridge.serve('core', 'server.authorize', (a) => authorize(a || {}))
  bridge.serve('core', 'server.playItem', (a) => playItem(a || {}))

  return { ping, authorize, playItem }
}
