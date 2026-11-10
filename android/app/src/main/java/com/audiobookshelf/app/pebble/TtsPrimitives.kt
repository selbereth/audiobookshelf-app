package com.audiobookshelf.app.pebble

import android.content.Context
import com.audiobookshelf.app.tts.TtsController
import com.audiobookshelf.app.tts.TtsHeadless
import com.audiobookshelf.app.tts.TtsService
import com.audiobookshelf.app.tts.TtsSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * What the shared Pebble logic (`utils/pebble/hub.js`) asks of the EPUB read-aloud: small steps, no decisions. The reading itself
 * is the web part's (`utils/tts/ttsSession.js`); without the app's screen it runs in a hidden page ([TtsHeadless]).
 */
class TtsPrimitives(private val context: Context) {
  private val controller get() = TtsService.instance?.controller

  /** The reading speed: the one place it is kept is [TtsController] */
  private fun rate(): Float = controller?.rate ?: TtsController.savedRate(context).takeIf { it > 0f } ?: 1f

  fun state(): JSONObject {
    val snapshot = TtsSnapshot.load(context)
    return JSONObject().put("live", TtsService.instance != null).put("playing", controller?.playing == true)
      .put("rate", rate().toString().toDouble())
      .put(
        "snapshot",
        snapshot?.let {
          JSONObject().put("title", it.title).put("chapter", it.chapter).put("chapterNumber", it.chapterNumber).put("chapterCount", it.chapterCount)
            .put("progress", it.progress).put("updatedAt", it.updatedAt).put("chapterStart", it.chapterStart).put("chapterEnd", it.chapterEnd)
            .put("session", it.session)
        } ?: JSONObject.NULL
      )
  }

  suspend fun playPause() {
    val service = TtsService.instance ?: return
    withContext(Dispatchers.Main) { if (service.controller.playing) service.controller.pause() else service.startPlayback() }
  }

  suspend fun pause() {
    controller?.let { withContext(Dispatchers.Main) { it.pause() } }
  }

  suspend fun skip(forward: Boolean) {
    val service = TtsService.instance ?: return
    withContext(Dispatchers.Main) { service.controller.skip("paragraph", if (forward) 1 else -1) }
  }

  /** [TtsController.changeRate] saves it, applies it to the voice and tells the app's screen: the same call the screen's own control ends in */
  suspend fun setRate(rate: Float) {
    val live = controller
    if (live != null) withContext(Dispatchers.Main) { live.changeRate(rate) } else TtsController.saveRate(context, rate)
  }

  /** Carries on a saved session in the hidden page (the app is closed) */
  fun resume(session: String) = TtsHeadless.resume(context, session)

  /** Reads a book that was never read aloud, in the hidden page */
  fun startNew(request: String) = TtsHeadless.startNew(context, request)
}
