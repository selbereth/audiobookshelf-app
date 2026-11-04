/** The page the JS core runs in (CoreHost.kt loads it in a hidden WebView). It only wires the native transport to core.js. */
import { createCore } from './core'

const transport = {
  call: (connector, method, args, id) => window.NativeCore.call(connector, method, args, id),
  answerUp: (id, ok, json) => window.NativeCore.answerUp(id, ok, json),
  ready: () => window.NativeCore.ready()
}

const core = createCore(transport)
window.core = core
window.__core = {
  reply: (id, ok, json) => core.bridge.handleReply(id, ok, json),
  event: (connector, event, json, t) => core.bridge.handleEvent(connector, event, json, t),
  callUp: (id, connector, method, json) => core.bridge.handleCallUp(id, connector, method, json)
}
core.bridge.ready()
