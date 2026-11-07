package com.audiobookshelf.app.core

import android.content.Context
import com.audiobookshelf.app.pebble.PebblePrimitives
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The Pebble watch's facts for the core (Phase 7, switch corePebble): the message to the watch (`pebble.send`), the volume, the
 * downloads, the read-aloud (`tts.*`), the last library and the saved speed. Each is one primitive of PebblePrimitives, unchanged;
 * nothing here decides. Only the names in [facts] are answered: the decisions are in utils/core/modules/pebble.js.
 */
class PebbleConnector(private val context: Context) : Connector {
  private val primitives by lazy { PebblePrimitives(context) }
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  private val facts = setOf("device.volume", "device.adjustVolume", "api.lastLibraryId", "local.books", "local.ebookProgress", "pebble.send")

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method == "savedRate") return reply(true, savedRate().toString())
    if (method !in facts && !method.startsWith("tts.")) return reply(false, "unknown pebble.$method")
    scope.launch {
      try {
        reply(true, encode(primitives.call(method, args)))
      } catch (e: Exception) {
        reply(false, e.message ?: "failed")
      }
    }
  }

  private fun encode(result: Any?): String = when (result) {
    null, Unit -> "null"
    is String -> JSONObject.quote(result)
    else -> result.toString()
  }

  /** The playback speed the app saved (the player's copy when it runs), as AudioPrimitives.speed read it */
  private fun savedRate(): Float {
    PlayerConnector.service?.let { return it.mediaManager.getSavedPlaybackRate() }
    val prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
    return runCatching { JSONObject(prefs.getString("userSettings", null) ?: "").getDouble("playbackRate").toFloat() }.getOrDefault(1f)
  }
}
