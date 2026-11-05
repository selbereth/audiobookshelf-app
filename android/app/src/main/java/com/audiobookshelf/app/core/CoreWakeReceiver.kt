package com.audiobookshelf.app.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** The `wake` connector's alarm. Turns the alarm into an event for the core, nothing else. */
class CoreWakeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CoreHost.start(context) // the process may have been started by this alarm
    CoreHost.emit("wake", "wake", JSONObject().put("id", intent.getStringExtra("id")).put("atMs", intent.getLongExtra("atMs", 0)).put("exact", intent.getBooleanExtra("exact", false)))
  }
}
