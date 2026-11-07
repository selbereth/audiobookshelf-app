package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * `sensor.register` / `sensor.unregister`: the shake sensor for the core's sleep timer (Phase 5). Register is idempotent
 * (PlayerNotificationService.registerSensor); unregister is immediate, the core owns the 2 minute window.
 * Event up: `sensor shake {}` when the phone is shaken (the core decides what a shake does).
 */
object SensorConnector : Connector {
  private val main = Handler(Looper.getMainLooper())

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    main.post {
      val s = PlayerConnector.service
      when (method) {
        "register" -> s?.registerSensor()
        "unregister" -> s?.unregisterSensorNow()
        else -> return@post reply(false, "unknown sensor.$method")
      }
      Log.i("SensorConnector", "sensor.$method live=${s != null}")
      reply(true, JSONObject().put("live", s != null).toString())
    }
  }

  fun emitShake() = CoreHost.emit("sensor", "shake")
}
