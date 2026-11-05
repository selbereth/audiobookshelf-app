package com.audiobookshelf.app.core

import com.audiobookshelf.app.plugins.AbsCore
import org.json.JSONObject

/** `ui.emit({event, data})`: hands an event of the core to the visible web view (AbsCore plugin). Dropped when no UI is open. */
class UiConnector : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method != "emit") return reply(false, "unknown ui.$method")
    val delivered = AbsCore.send(args.getString("event"), args.optJSONObject("data") ?: JSONObject())
    reply(true, JSONObject().put("delivered", delivered).toString())
  }
}
