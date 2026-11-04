package com.audiobookshelf.app.core

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import org.json.JSONObject

/**
 * `wake.schedule({id, atMs})` sets an exact alarm when Android allows it (inexact otherwise); `wake.cancel({id})` removes it.
 * When it goes off, [CoreWakeReceiver] sends the event `wake {id, atMs, exact}` to the core. The core decides what a wake means.
 */
class WakeConnector(private val context: Context) : Connector {
  private val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun pending(id: String, atMs: Long, exact: Boolean): PendingIntent {
    val intent = Intent(context, CoreWakeReceiver::class.java).putExtra("id", id).putExtra("atMs", atMs).putExtra("exact", exact)
    return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    val id = args.getString("id")
    when (method) {
      "schedule" -> {
        val atMs = args.getLong("atMs")
        val exact = alarms.canScheduleExactAlarms()
        val trigger = SystemClock.elapsedRealtime() + (atMs - System.currentTimeMillis())
        val p = pending(id, atMs, exact)
        if (exact) alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, p)
        else alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, p)
        reply(true, JSONObject().put("exact", exact).toString())
      }
      "cancel" -> {
        alarms.cancel(pending(id, 0, false))
        reply(true, "")
      }
      else -> reply(false, "unknown wake.$method")
    }
  }
}
