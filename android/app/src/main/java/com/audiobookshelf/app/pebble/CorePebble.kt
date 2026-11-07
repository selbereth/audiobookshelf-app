package com.audiobookshelf.app.pebble

import android.content.Context
import com.audiobookshelf.app.core.CoreHost
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * Phase 7: the watch logic runs in the core (utils/core/modules/pebble.js) instead of PebbleHost. Used by PebbleHost.call only when
 * CoreSwitch.corePebble is on, so with the switch off nothing here runs. Answers the JSON the logic returned, or null.
 */
object CorePebble {
  suspend fun call(context: Context, method: String, args: JSONArray, timeoutMs: Long): String? = suspendCancellableCoroutine { cont ->
    CoreHost.start(context)
    val payload = JSONObject().put("method", method).put("args", args)
    CoreHost.callUp("pebble", "run", payload, timeoutMs) { ok, json ->
      if (cont.isActive) cont.resume(if (ok) json else null)
    }
  }
}
