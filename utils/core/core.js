/**
 * The JS core. Plain JS: no document, no Vue, no Vuex, so it runs in the hidden web view, in Node tests with a fake
 * transport, and later in JavaScriptCore on iOS. It owns every app decision; native only supplies connectors.
 * Later phases add their modules here (store, api, player, ...).
 */
import { createBridge } from './bridge'
import { diagnosticsModule } from './modules/diagnostics'
import { dbModule } from './modules/db'
import { apiModule } from './modules/api'

export function createCore(transport, { log = console.log, now = () => Date.now() } = {}) {
  const bridge = createBridge(transport)

  // The UI is a client of the core: it calls `core` methods through the AbsCore plugin and gets `ui` events (see modules)
  bridge.serve('core', 'ping', () => ({ pong: now() }))
  bridge.serve('core', 'version', () => ({ core: 1 }))
  diagnosticsModule(bridge, { log, now })

  /** Tell the visible UI something happened (it may not be open: native drops it) */
  const emitToUi = (event, data = {}) => bridge.call('ui', 'emit', { event, data }).catch(() => {})

  const db = dbModule(bridge, { log, now, emitToUi })
  const api = apiModule(bridge, { log, db })

  // The UI says hello when it opens; the core answers and also sends an event, so both directions can be seen
  bridge.serve('core', 'hello', () => {
    emitToUi('hello', { t: now() })
    return { ok: true }
  })

  return { bridge, emitToUi, db, api }
}
