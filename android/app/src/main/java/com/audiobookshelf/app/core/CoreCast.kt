package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * Asks the core for the Cast decisions (Phase 10, slice C1): the player switch and the device volume. Used only while
 * CoreSwitch.coreCast is on and CoreHost is ready. The answer comes back on the main thread; null = the core did not answer
 * (no core, refused, timed out), and the caller runs its own rule. The core decides (utils/core/modules/cast.js).
 */
object CoreCast {
  private const val TIMEOUT_MS = 3000L

  /** Answer {noop, stop: 'exo'|'cast'|null, notifyPaused}, or null */
  fun switchPlan(useCast: Boolean, current: String, hasCastPlayer: Boolean, wasPlaying: Boolean, done: (JSONObject?) -> Unit) {
    val args = JSONObject().put("useCast", useCast).put("current", current).put("hasCastPlayer", hasCastPlayer).put("wasPlaying", wasPlaying)
    ask("switchPlan", args) { json -> done(json) }
  }

  /** The volume to set (clamped by the core), or null */
  fun volumeSet(volume: Int, done: (Int?) -> Unit) {
    ask("volumeSet", JSONObject().put("volume", volume)) { json -> done(json?.optInt("volume")?.takeIf { json.has("volume") }) }
  }

  /** The volume after the step (clamped by the core), or null */
  fun volumeAdjust(current: Int, direction: Int, done: (Int?) -> Unit) {
    ask("volumeAdjust", JSONObject().put("current", current).put("direction", direction)) { json ->
      done(json?.optInt("volume")?.takeIf { json.has("volume") })
    }
  }

  /** The answer's JSON when the core said ok; null otherwise */
  private fun ask(method: String, args: JSONObject, done: (JSONObject?) -> Unit) {
    CoreHost.callUp("cast", method, args, TIMEOUT_MS) { ok, json ->
      val answer = if (ok) try { JSONObject(json) } catch (e: Exception) { null } else null
      Handler(Looper.getMainLooper()).post { done(answer?.takeIf { it.optBoolean("ok") }) }
    }
  }
}
