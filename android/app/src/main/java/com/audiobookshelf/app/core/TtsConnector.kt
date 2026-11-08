package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import com.audiobookshelf.app.tts.TtsService
import org.json.JSONObject

/**
 * `tts.pause {reason}` for the core's read-aloud sleep timer (Phase 10, slice B). Only the device call: the core decides when to pause
 * (utils/core/modules/tts.js). Used while CoreSwitch.coreTts is on.
 */
class TtsConnector : Connector {
  private val main = Handler(Looper.getMainLooper())

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "pause" -> {
        val reason = args.optString("reason", "").ifEmpty { null }
        main.post { TtsService.instance?.controller?.pause(reason) }
        reply(true, "")
      }
      else -> reply(false, "unknown tts.$method")
    }
  }
}
