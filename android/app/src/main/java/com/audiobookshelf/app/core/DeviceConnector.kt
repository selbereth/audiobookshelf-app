package com.audiobookshelf.app.core

import com.audiobookshelf.app.device.DeviceManager
import org.json.JSONObject

/**
 * `device.sync({currentServerId?, settingsChanged?})`: transitional mirror for the Kotlin that has not moved to the core yet.
 * Reloads DeviceManager's copy of the device data from the store; when `currentServerId` is given (a string, or null for none)
 * it also makes that connection the one DeviceManager serves; when `settingsChanged` is true it tells the player. Removed when
 * DeviceManager moves to the core (Phase 11).
 */
class DeviceConnector : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method != "sync") return reply(false, "unknown device.$method")
    DeviceManager.reloadDeviceData()
    if (args.has("currentServerId")) {
      DeviceManager.serverConnectionConfig = if (args.isNull("currentServerId")) null else DeviceManager.getServerConnectionConfig(args.getString("currentServerId"))
    }
    if (args.optBoolean("settingsChanged", false)) DeviceManager.onSettingsChanged?.invoke()
    reply(true, "")
  }
}
