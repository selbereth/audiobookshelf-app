package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * Calls the core's sleep timer (Phase 5) from the app's screen, the player and the debug receiver. Used only while
 * CoreSwitch.coreSleep is on. Methods: set {ms, isChapterTime, sessionId}, increase {ms}, decrease {ms}, cancel, resend.
 * The answer comes back on the main thread.
 */
object CoreSleep {
  fun call(method: String, args: JSONObject = JSONObject(), done: (ok: Boolean, json: String) -> Unit = { _, _ -> }) {
    CoreHost.callUp("sleep", method, args, 5000) { ok, json ->
      Handler(Looper.getMainLooper()).post { done(ok, json) }
    }
  }

  /** The `success` of the sleep timer answer {ok}; a timeout or a bad answer is a failure */
  fun succeeded(ok: Boolean, json: String): Boolean = ok && try {
    JSONObject(json).optBoolean("ok")
  } catch (e: Exception) {
    false
  }
}
