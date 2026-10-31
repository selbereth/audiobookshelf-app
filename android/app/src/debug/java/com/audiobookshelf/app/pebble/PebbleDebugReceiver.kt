package com.audiobookshelf.app.pebble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.audiobookshelf.app.managers.DbManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * Debug builds only: sends a message to the shared Pebble logic as if the watch had, from adb, so the phone side can be tried
 * without a watch. The messages it would send to the watch are in logcat (tag PebbleListenerService, "No watch to send to").
 *
 *   adb shell am broadcast -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.pebble.PebbleDebugReceiver --ei command 1
 *
 * command: 0 hello (status), 1 play or pause, 2 skip ahead, 3 skip back, 4 volume up, 5 volume down, 6 speed up, 7 speed down,
 * 8 browse (--ei level, --ei shelf, --ei item), 9 start a book (--ei shelf, --ei item, --ei format; 255 = ask).
 * Key numbers are in utils/pebble/protocol.js. Starting from adb is not subject to the limits Android puts on starting a media
 * service from the background, so this does not show whether that works when the watch asks.
 */
class PebbleDebugReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    val pending = goAsync()
    CoroutineScope(Dispatchers.Default).launch {
      try {
        DbManager.initialize(app)
        val message = JSONObject().put("0", intent.getIntExtra("command", 0))
        if (intent.hasExtra("level")) message.put("14", intent.getIntExtra("level", 0))
        if (intent.hasExtra("shelf")) message.put("17", intent.getIntExtra("shelf", 0))
        if (intent.hasExtra("item")) message.put("18", intent.getIntExtra("item", 0))
        if (intent.hasExtra("format")) message.put("19", intent.getIntExtra("format", 255))
        PebbleHost.call(app, "handle", JSONArray().put(message))
        Log.i("PebbleDebug", "handled $message")
      } catch (e: Exception) {
        Log.e("PebbleDebug", "failed", e)
      } finally {
        pending.finish()
      }
    }
  }
}
