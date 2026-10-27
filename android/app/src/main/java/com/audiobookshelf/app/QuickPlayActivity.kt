package com.audiobookshelf.app

import android.app.Activity
import android.os.Bundle
import android.widget.Toast
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.pebble.PebbleController
import com.audiobookshelf.app.pebble.PebbleProtocol
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
    // The work outlives this activity: it finishes as soon as the start command is given
    scope.launch {
      val controller = PebbleController(context)
      try {
        DbManager.initialize(context)
        val before = controller.status()
        val status = controller.startPlaying()
        android.util.Log.i("QuickPlay", "state before=${before.state} after=${status.state} title='${status.title}'")
        runOnUiThread {
          when (status.state) {
            PebbleProtocol.STATE_NOTHING_TO_PLAY -> toast(context.getString(R.string.quick_play_nothing))
            PebbleProtocol.STATE_ERROR -> toast(status.title)
            PebbleProtocol.STATE_LOADING -> toast(context.getString(R.string.quick_play_starting, status.title))
          }
          finish()
        }
        if (status.state == PebbleProtocol.STATE_LOADING) controller.waitUntilPlaying()
      } catch (e: Exception) {
        android.util.Log.e("QuickPlay", "Could not start the most recent book", e)
        runOnUiThread { finish() }
      } finally {
        controller.release()
      }
    }
  }

  private fun toast(text: String) = Toast.makeText(applicationContext, text, Toast.LENGTH_LONG).show()

  companion object {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * This activity runs in a task of its own that is gone as soon as it finishes. The players treat "a task was removed" as the
     * user swiping the app away and stop: they must ignore it for this one.
     */
    fun isQuickPlayTask(rootIntent: android.content.Intent?): Boolean = rootIntent?.component?.className == QuickPlayActivity::class.java.name
  }
}
