package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * `timer.schedule({id, atMs})` fires once at the time the core names (wall clock, ms); `timer.cancel({id})` removes it. Scheduling
 * the same id again replaces the pending tick. When it fires, the event `timer tick {id, atMs}` goes to the core, nothing else:
 * the core asks for the next one. Runs on the main thread, so it keeps working while the UI is closed (the process stays up).
 */
class TimerConnector : Connector {
  private val main = Handler(Looper.getMainLooper())
  private val pending = HashMap<String, Runnable>() // main thread only

  private fun cancelPending(id: String) {
    pending.remove(id)?.let { main.removeCallbacks(it) }
  }

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "schedule" -> {
        val id = args.getString("id")
        val atMs = args.getLong("atMs")
        main.post {
          Log.d("TimerConnector", "schedule $id atMs=$atMs")
          cancelPending(id)
          val tick = Runnable {
            pending.remove(id)
            CoreHost.emit("timer", "tick", JSONObject().put("id", id).put("atMs", atMs))
          }
          pending[id] = tick
          main.postDelayed(tick, maxOf(0L, atMs - System.currentTimeMillis()))
          reply(true, "")
        }
      }
      "cancel" -> {
        val id = args.getString("id")
        main.post {
          Log.d("TimerConnector", "cancel $id")
          cancelPending(id)
          reply(true, "")
        }
      }
      else -> reply(false, "unknown timer.$method")
    }
  }
}
