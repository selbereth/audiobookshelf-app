/**
 * Calls to the Audiobookshelf server, from the core. Native only moves the bytes (`http.request`); the authorization header, the
 * token refresh on a 401 and the single retry are decided here.
 *
 * `api.request({method, endpoint, payload, address, token, serverConnectionConfigId, timeoutMs})` answers what the Kotlin
 * ApiHandler always answered, so its callers did not change: the parsed JSON object, an array wrapped as {value: [...]}, "OK" as
 * {}, and {error: "..."} for every failure. The caller says which server (address, token, id): the core does not guess.
 * A caller that names no server gets the current one (resolveServer). `api.refreshAuthTokens({serverConnectionConfigId})` -> {result: 'success' | 'rejected' | 'transient', accessToken?}.
 */
export function apiModule(bridge, { log = console.log, db }) {
  const DEFAULT_TIMEOUT = 60000

  /** {ok, status, body} or null when the server could not be reached */
  async function send({ method, url, token, body, timeoutMs }) {
    try {
      // No Authorization header without a token (an empty bearer is never sent); anonymous endpoints such as /ping need none
      const headers = token ? { Authorization: 'Bearer ' + token } : {}
      const r = await bridge.call('http', 'request', { method, url, headers, body, timeoutMs })
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.body }
    } catch (e) {
      log('api: ' + method + ' ' + url + ' failed: ' + (e && e.message))
      return null
    }
  }

  /** The body the way the Kotlin callers expect it */
  function parseBody(text) {
    if (text === 'OK') return {}
    try {
      const v = JSON.parse(text)
      if (Array.isArray(v)) return { value: v }
      if (v && typeof v === 'object') return v
    } catch (e) {
      // falls through
    }
    log('api: invalid JSON response body')
    return { error: 'Invalid response body' }
  }

  /**
   * The server a call goes to: the one the caller names (address, token, serverConnectionConfigId), else the current one
   * (the device's lastServerConnectionConfigId). Null when there is no current server.
   */
  async function resolveServer({ address, token, serverConnectionConfigId } = {}) {
    if (address) return { address, token, serverConnectionConfigId }
    const data = await db.methods.getDeviceData()
    const config = data.serverConnectionConfigs.find((c) => c.id === data.lastServerConnectionConfigId)
    if (!config) return null
    return { address: config.address, token: config.token, serverConnectionConfigId: config.id }
  }

  async function request({ method = 'GET', endpoint, payload, timeoutMs = DEFAULT_TIMEOUT, anonymous = false, ...named }) {
    const srv = await resolveServer(named)
    if (!srv) return { error: 'No server connection' }
    const { address, token, serverConnectionConfigId } = srv
    if (!token && !anonymous) return { error: 'No access token for this server' }
    const url = address + endpoint
    const body = payload === undefined || payload === null ? null : JSON.stringify(payload)
    let r = await send({ method, url, token, body, timeoutMs })
    if (!r) return { error: 'Failed to connect' }
    if (r.status === 401) {
      log('api: 401 for ' + url + ' - attempting token refresh')
      const refreshed = serverConnectionConfigId ? await refreshAuthTokens({ serverConnectionConfigId }) : { result: 'rejected' }
      // transient: the refresh could not be completed (unreachable, 5xx): the login is kept, so do not ask for a new one
      if (refreshed.result === 'transient') return { error: 'Could not refresh the login - try again' }
      if (refreshed.result !== 'success') return { error: 'Authentication failed - login again' }
      r = await send({ method, url, token: refreshed.accessToken, body, timeoutMs })
      if (!r) return { error: 'Failed to retry request after token refresh' }
      if (!r.ok) return { error: 'Retry request failed with status ' + r.status }
    } else if (!r.ok) {
      return { error: 'Unexpected code ' + r.status }
    }
    return parseBody(r.body)
  }

  // One refresh at a time for a server: a refresh token works once, so two at the same time would reject each other
  const refreshing = new Map()
  function refreshAuthTokens({ serverConnectionConfigId }) {
    if (refreshing.has(serverConnectionConfigId)) return refreshing.get(serverConnectionConfigId)
    const p = doRefresh(serverConnectionConfigId, 2).finally(() => refreshing.delete(serverConnectionConfigId))
    refreshing.set(serverConnectionConfigId, p)
    return p
  }

  async function doRefresh(id, retriesLeft) {
    const data = await db.methods.getDeviceData()
    const config = data.serverConnectionConfigs.find((c) => c.id === id)
    const stored = await bridge.call('secure', 'get', { key: id })
    const refreshToken = stored && stored.value
    if (!config || !refreshToken) {
      log('api: no refresh token or server configuration for ' + id)
      await db.serial(() => db.methods.clearSession({ serverConnectionConfigId: id }))
      return { result: 'rejected' }
    }
    let r
    try {
      r = await bridge.call('http', 'request', {
        method: 'POST', url: config.address + '/auth/refresh', timeoutMs: DEFAULT_TIMEOUT,
        headers: { 'x-refresh-token': refreshToken, 'Content-Type': 'application/json' }
      })
    } catch (e) {
      log('api: token refresh failed for ' + config.name + ': ' + (e && e.message))
      return { result: 'transient' }
    }
    if (r.status < 200 || r.status >= 300) {
      log('api: token refresh returned ' + r.status + ' for ' + config.name)
      if (r.status !== 401 && r.status !== 403) return { result: 'transient' }
      // A refresh token works once. If another refresh got there first, the stored token is already the next one: use it
      const latest = await bridge.call('secure', 'get', { key: id })
      if (retriesLeft > 0 && latest && latest.value && latest.value !== refreshToken) {
        log('api: refresh token was replaced while refreshing for ' + config.name + ', retrying with the new one')
        return doRefresh(id, retriesLeft - 1)
      }
      await db.serial(() => db.methods.clearSession({ serverConnectionConfigId: id }))
      return { result: 'rejected' }
    }
    let user
    try {
      user = JSON.parse(r.body).user
    } catch (e) {
      log('api: could not parse refresh response for ' + config.name)
      return { result: 'transient' }
    }
    const accessToken = (user && user.accessToken) || ''
    if (!accessToken) {
      log('api: refresh response had no access token for ' + config.name)
      return { result: 'transient' }
    }
    await db.serial(() => db.methods.updateTokens({ serverConnectionConfigId: id, accessToken, refreshToken: (user && user.refreshToken) || refreshToken }))
    return { result: 'success', accessToken }
  }

  bridge.serve('core', 'api.request', (args) => request(args || {}))
  bridge.serve('core', 'api.refreshAuthTokens', (args) => refreshAuthTokens(args || {}))

  return { request, refreshAuthTokens, resolveServer }
}
