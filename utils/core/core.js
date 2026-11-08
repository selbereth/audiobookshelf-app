/**
 * The JS core. Plain JS: no document, no Vue, no Vuex, so it runs in the hidden web view, in Node tests with a fake
 * transport, and later in JavaScriptCore on iOS. It owns every app decision; native only supplies connectors.
 * Later phases add their modules here (store, api, player, ...).
 */
import { createBridge } from './bridge'
import { diagnosticsModule } from './modules/diagnostics'
import { dbModule } from './modules/db'
import { apiModule } from './modules/api'
import { syncModule } from './modules/sync'
import { progressModule } from './modules/progress'
import { serverModule } from './modules/server'
import { tickModule } from './modules/tick'
import { saverModule } from './modules/saver'
import { sleepModule } from './modules/sleep'
import { pebbleModule } from './modules/pebble'
import { downloadsModule } from './modules/downloads'
import { playerModule } from './modules/player'

export function createCore(transport, { log = console.log, now = () => Date.now() } = {}) {
  const bridge = createBridge(transport)

  // The UI is a client of the core: it calls `core` methods through the AbsCore plugin and gets `ui` events (see modules)
  bridge.serve('core', 'ping', () => ({ pong: now() }))
  bridge.serve('core', 'version', () => ({ core: 1 }))
  const tick = tickModule(bridge, { now })
  diagnosticsModule(bridge, { log, now, tick })

  /** Tell the visible UI something happened (it may not be open: native drops it) */
  const emitToUi = (event, data = {}) => bridge.call('ui', 'emit', { event, data }).catch(() => {})

  const db = dbModule(bridge, { log, now, emitToUi })
  const api = apiModule(bridge, { log, db })
  const sync = syncModule(bridge, { log, db, api })
  const progress = progressModule(bridge, { api, db })
  const server = serverModule(bridge, { api })
  // Progress saving decisions (Phase 4b-2/4b-3). start() reads the switch (system.flags coreSaver, default off): while it is off
  // nothing here saves or sends, and Kotlin's MediaProgressSyncer does
  const saver = saverModule(bridge, {
    progress,
    db,
    tick,
    now,
    log,
    alert: (kind) => emitToUi('progressSync', { kind }),
    emit: (event, data) => emitToUi(event, data)
  })
  saver.start()
  // Sleep timer (Phase 5): start() reads the switch system.flags {coreSleep}, default off. While it is off Kotlin's SleepTimerManager runs
  const sleep = sleepModule(bridge, { tick, db, now, log, emitToUi: (event, data) => emitToUi(event, data) })
  sleep.start()
  // The UI mirror of the device data (Phase 6): reads the switch system.flags {coreUi}, default off
  db.start()
  // The Pebble watch logic (Phase 7): runs only when native calls `pebble` / `run` (switch corePebble on)
  const pebble = pebbleModule(bridge, { api, server, db, log })
  // Download decisions (Phase 8, slice 1): pure calls, answered on demand while the switch coreDownload is on in native
  downloadsModule(bridge)
  // Player control (Phase 9, slice 1): the auto-rewind after a pause. start() reads the switch system.flags {corePlayer}, default off
  const player = playerModule(bridge, { db, tick, server, now, log })
  player.start()

  // The UI says hello when it opens; the core answers and also sends an event, so both directions can be seen
  bridge.serve('core', 'hello', () => {
    emitToUi('hello', { t: now() })
    return { ok: true }
  })

  return { bridge, emitToUi, db, api, sync, progress, server, tick, saver, sleep, pebble, player }
}
