package com.audiobookshelf.app.plugins

import com.audiobookshelf.app.core.CoreHost
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * The visible web view's connection to the JS core (the UI is a client of the core). `call` asks a `core` method and waits for the
 * answer; events the core sends with `ui.emit` arrive as the plugin event `core` {event, data}. Native relays, it decides nothing.
 */
@CapacitorPlugin(name = "AbsCore")
class AbsCore : Plugin() {
  override fun load() {
    instance = this
  }

  override fun handleOnDestroy() {
    if (instance === this) instance = null
  }

  @PluginMethod
  fun call(call: PluginCall) {
    val method = call.getString("method") ?: return call.reject("method missing")
    val args = JSONObject((call.getObject("args") ?: JSObject()).toString())
    CoreHost.callUp("core", method, args, call.getLong("timeoutMs") ?: 10000L) { ok, json ->
      if (ok) call.resolve(JSObject().put("result", if (json.isEmpty()) JSONObject.NULL else org.json.JSONTokener(json).nextValue()))
      else call.reject(json)
    }
  }

  companion object {
    private var instance: AbsCore? = null

    /** True when the UI is open and got the event */
    fun send(event: String, data: JSONObject): Boolean {
      val plugin = instance ?: return false
      plugin.notifyListeners("core", JSObject().put("event", event).put("data", JSObject(data.toString())))
      return true
    }
  }
}
