package com.audiobookshelf.app

import android.app.Activity
import android.os.Bundle
import android.widget.Toast
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.pebble.PebbleHost
import org.json.JSONArray
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The "Play" action of the app icon's long press menu. It has no screen: it starts the most recent book (read aloud or audiobook,
 * the same as the play button on the watch) and closes at once. It only plays, it never pauses.
 */
class QuickPlayActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val context = applicationContext
    // Close at once: the window is translucent and would swallow every touch until the hub answers. The work below outlives it.
    finish()
    scope.launch {
      try {
        DbManager.initialize(context)
        // The shared Pebble logic does it (utils/pebble/hub.js): start the most recent book, read aloud or audiobook
        val first = JSONObject(PebbleHost.call(context, "startPlaying") ?: throw IllegalStateException("The Pebble logic did not answer"))
        val state = first.optInt("state")
        val title = first.optString("title")
        android.util.Log.i("QuickPlay", "state=$state title='$title'")
        mainHandler.post {
          when (state) {
            STATE_NOTHING_TO_PLAY -> toast(context.getString(R.string.quick_play_nothing))
            STATE_ERROR -> toast(title)
            STATE_LOADING -> toast(context.getString(R.string.quick_play_starting, title))
          }
        }
        if (state == STATE_LOADING) PebbleHost.call(context, "awaitPlaying", JSONArray().put(first.optInt("kind")))
      } catch (e: Exception) {
        android.util.Log.e("QuickPlay", "Could not start the most recent book", e)
      }
    }
  }

  private fun toast(text: String) = Toast.makeText(applicationContext, text, Toast.LENGTH_LONG).show()

  private val mainHandler get() = Companion.mainHandler

  companion object {
    // The states the shared Pebble logic reports (utils/pebble/protocol.js)
    private const val STATE_NOTHING_TO_PLAY = 0
    private const val STATE_LOADING = 3
    private const val STATE_ERROR = 4
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * This activity runs in a task of its own that is gone as soon as it finishes. The players treat "a task was removed" as the
     * user swiping the app away and stop: they must ignore it for this one.
     */
    fun isQuickPlayTask(rootIntent: android.content.Intent?): Boolean = rootIntent?.component?.className == QuickPlayActivity::class.java.name
  }
}
