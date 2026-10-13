package com.audiobookshelf.app.pebble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.audiobookshelf.app.managers.DbManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Debug builds only: does what the watch asks, from adb, so the phone side can be tried without a watch.
 *
 *   adb shell am broadcast -n com.audiobookshelf.app.debug/com.audiobookshelf.app.pebble.PebbleDebugReceiver --ei command 1
 *
 * command: 0 = status, 1 = play or pause (starts the most recent book), 2 = skip ahead, 3 = skip back.
 * The result is in logcat under the tag PebbleDebug. Starting from adb is not subject to the limits Android puts on
 * starting a media service from the background, so this does not show whether that works when the watch asks.
 */
class PebbleDebugReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val command = intent.getIntExtra("command", PebbleProtocol.CMD_HELLO)
    val app = context.applicationContext
    val pending = goAsync()
    CoroutineScope(Dispatchers.Default).launch {
      try {
        DbManager.initialize(app)
        val controller = PebbleController(app)
        val status = controller.handle(command)
        Log.i("PebbleDebug", "command=$command -> state=${status.state} title='${status.title}'")
        // As the listener service does: a book that is starting is followed until it is playing
        if (status.state == PebbleProtocol.STATE_LOADING) {
          val playing = controller.waitUntilPlaying()
          Log.i("PebbleDebug", "command=$command, after starting -> state=${playing.state} title='${playing.title}'")
        }
      } catch (e: Exception) {
        Log.e("PebbleDebug", "command=$command failed", e)
      } finally {
        pending.finish()
      }
    }
  }
}
