package com.audiobookshelf.app.tts

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat
import com.audiobookshelf.app.data.Book
import com.audiobookshelf.app.data.LocalMediaProgress
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.server.ApiHandler
import com.getcapacitor.JSObject
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Reads an EPUB aloud without the app's screen. The reading is done by the web part (it opens the book and cuts the text
 * into sentences), so this runs the same session code in a WebView nobody sees (assets/tts-headless, built from
 * utils/tts/headless). It plays the part of the AbsTts plugin for that page. Started by the Pebble watch when the app is
 * closed: Android does not let a background app open its screen, and none is wanted.
 */
object TtsHeadless {
  private const val TAG = "TtsHeadless"
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private val http = OkHttpClient()

  private val svc get() = TtsService.instance

  /** Opens the saved [session] (the JSON the web part saved) and reads on from where it was left */
  @SuppressLint("SetJavaScriptEnabled")
  fun resume(context: Context, session: String) {
    main.post {
      shutdownNow()
      val app = context.applicationContext
      val view = WebView(app)
      webView = view
      view.settings.javaScriptEnabled = true
      view.settings.domStorageEnabled = true
      view.webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
          Log.d(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
          return true
        }
      }
      view.addJavascriptInterface(Bridge(app), "NativeTts")
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(page: WebView, url: String?) {
          page.evaluateJavascript("ttsHeadless.resume(JSON.parse(${JSONObject.quote(session)})).catch(e => console.error('resume failed: ' + e))", null)
        }
      }
      TtsService.eventListener = forwarder
      view.loadUrl("file:///android_asset/tts-headless/index.html")
    }
  }

  /** The hidden reading was speaking when the app's screen opened: the screen carries on reading instead of staying paused */
  @Volatile private var resumeAfterHandOver = false

  /** Asked once by the app's screen at start */
  fun consumeResumeAfterHandOver(): Boolean {
    val value = resumeAfterHandOver
    resumeAfterHandOver = false
    return value
  }

  /** True while the hidden page is running a session */
  val isRunning get() = webView != null

  /** The app's screen is opening and takes over: write down where the reading is, stop it and let go of the page */
  fun handOver() {
    val view = webView ?: return
    resumeAfterHandOver = TtsService.instance?.controller?.playing == true
    main.post {
      view.evaluateJavascript("ttsHeadless.handOver().catch(e => console.error('handOver failed: ' + e))", null)
      main.postDelayed({ shutdownNow() }, 2000)
    }
  }

  private fun shutdownNow() {
    val view = webView ?: return
    webView = null
    runCatching {
      view.removeJavascriptInterface("NativeTts")
      view.destroy()
    }
    if (TtsService.eventListener === forwarder) TtsService.eventListener = null
  }

  private fun toJs(name: String, data: JSONObject = JSONObject()) {
    main.post { webView?.evaluateJavascript("window.__ttsEvent(${JSONObject.quote(name)}, ${JSONObject.quote(data.toString())})", null) }
  }

  private val forwarder = object : TtsController.Listener {
    override fun onSentence(s: TtsSentence) = toJs("sentence", JSONObject().put("id", s.id).put("cfi", s.cfi).put("spine", s.spine))
    override fun onState(playing: Boolean, reason: String?) {
      toJs("state", JSONObject().put("playing", playing).put("reason", reason ?: JSONObject.NULL))
      // Stopped for good (the service was stopped): the page is no longer needed once it has written things down
      if (reason == "stopped") main.postDelayed({ shutdownNow() }, 3000)
    }
    override fun onNeedMore(streamId: Int, lastSeq: Int) = toJs("needMore", JSONObject().put("streamId", streamId).put("lastSeq", lastSeq))
    override fun onEnded() {
      toJs("ended")
      main.postDelayed({ shutdownNow() }, 5000)
    }
    override fun onError(code: String, message: String) = toJs("error", JSONObject().put("code", code).put("message", message))
    override fun onWord(id: Int, start: Int, end: Int) {}
  }

  private fun sentences(array: JSONArray?): List<TtsSentence> {
    val list = ArrayList<TtsSentence>(array?.length() ?: 0)
    for (i in 0 until (array?.length() ?: 0)) {
      val o = array!!.getJSONObject(i)
      list.add(TtsSentence(o.getInt("id"), o.getString("text"), o.getString("cfi"), o.optInt("spine"), o.optInt("paragraph")))
    }
    return list
  }

  /** The calls the web part makes to the AbsTts plugin, and the few it makes for files and progress */
  private class Bridge(private val context: Context) {
    @JavascriptInterface
    fun invoke(method: String, args: String, id: Int) {
      val input = JSONObject(args)
      fun reply(ok: Boolean, json: String = "") {
        main.post { webView?.evaluateJavascript("window.__ttsReply($id, $ok, ${JSONObject.quote(json)})", null) }
      }
      try {
        when (method) {
          "fetchBook" -> thread { // a download: not on the main thread
            try {
              reply(true, JSONObject().put("base64", Base64.encodeToString(readBook(input), Base64.NO_WRAP)).toString())
            } catch (e: Exception) {
              Log.e(TAG, "Could not read the book", e)
              reply(false, "Could not read the book: ${e.message}")
            }
          }
          "patchProgress" -> {
            // /api/me/progress/<libraryItemId>
            val libraryItemId = input.getString("url").substringAfterLast('/')
            ApiHandler(context).updateMediaProgress(libraryItemId, null, JSObject(input.getJSONObject("payload").toString())) {}
            reply(true)
          }
          else -> main.post {
            try {
              reply(true, onMain(method, input)?.toString() ?: "")
            } catch (e: Exception) {
              Log.e(TAG, "$method failed", e)
              reply(false, e.message ?: "failed")
            }
          }
        }
      } catch (e: Exception) {
        Log.e(TAG, "$method failed", e)
        reply(false, e.message ?: "failed")
      }
    }

    private fun onMain(method: String, input: JSONObject): JSONObject? {
      val service = svc
      when (method) {
        "start" -> {
          // Only one thing owns media playback: the caller has paused the audiobook player already
          ContextCompat.startForegroundService(context, Intent(context, TtsService::class.java).apply {
            action = TtsService.ACTION_START
            putExtra(TtsService.EXTRA_TITLE, input.optString("title"))
            putExtra(TtsService.EXTRA_AUTHOR, input.optString("author"))
            putExtra(TtsService.EXTRA_COVER_URI, input.optString("coverUri"))
          })
          waitForService(input, 0)
          return null
        }
        "appendChunk" -> {
          val s = service ?: throw IllegalStateException("No TTS session")
          s.controller.appendChunk(input.optInt("streamId"), input.optInt("seq"), sentences(input.optJSONArray("sentences")), input.optBoolean("done"), if (input.has("startId") && !input.isNull("startId")) input.getInt("startId") else null)
        }
        "prependChunk" -> {
          val s = service ?: throw IllegalStateException("No TTS session")
          s.controller.prependChunk(input.optInt("streamId"), sentences(input.optJSONArray("sentences")))
        }
        "play" -> service?.startPlayback()
        "pause" -> service?.controller?.pause()
        "stop" -> TtsService.requestStop()
        "skip" -> service?.controller?.skip(input.optString("by", "sentence"), input.optInt("count", 1))
        "seekToSentence" -> return JSONObject().put("found", service?.controller?.seekToSentence(input.optInt("id", -1)) ?: false)
        "reset" -> service?.controller?.reset(input.optInt("streamId"))
        "setRate" -> service?.controller?.updateVoice(newRate = input.optDouble("rate", 1.0).toFloat())
        "setPitch" -> service?.controller?.updateVoice(newPitch = input.optDouble("pitch", 1.0).toFloat())
        "setVoice" -> service?.controller?.updateVoice(newVoiceId = input.optString("voiceId"))
        "getState" -> {
          val c = service?.controller
          return JSONObject().put("active", c != null).put("playing", c?.playing ?: false)
        }
        "saveSnapshot" -> TtsSnapshot.save(
          context,
          TtsSnapshot(
            input.optString("libraryItemId"), input.optString("title"), input.optString("chapter"), input.optInt("chapterNumber"),
            input.optInt("chapterCount"), input.optDouble("progress"), System.currentTimeMillis(), input.optString("session")
          )
        )
        "clearSnapshot" -> TtsSnapshot.clear(context)
        "getSnapshot" -> return JSONObject().put("session", TtsSnapshot.load(context)?.session ?: "")
        "updateLocalEbookProgress" -> return updateLocalEbookProgress(input)
        // Sleep timers, voices and the text window are for the app's screen
        else -> {}
      }
      return null
    }

    /** Answers the page's start() once the service is up (it is created asynchronously) */
    private fun waitForService(input: JSONObject, tries: Int) {
      val s = svc
      if (s == null) {
        if (tries < 50) main.postDelayed({ waitForService(input, tries + 1) }, 50) else Log.e(TAG, "TTS service failed to start")
        return
      }
      s.controller.apply {
        reset(input.optInt("streamId"))
        lang = input.optString("lang").ifEmpty { null }
        voiceId = input.optString("voiceId").ifEmpty { null }
        rate = input.optDouble("rate", 1.0).toFloat()
        pitch = input.optDouble("pitch", 1.0).toFloat()
        updateVoice()
      }
    }

    private fun readBook(input: JSONObject): ByteArray {
      if (input.optBoolean("isLocal")) {
        val item = DeviceManager.dbManager.getLocalLibraryItem(input.optString("localLibraryItemId"))
          ?: throw IllegalStateException("The downloaded book is gone")
        val file = item.localFiles.firstOrNull { it.mimeType == "application/epub+zip" } ?: throw IllegalStateException("The downloaded EPUB is gone")
        return context.contentResolver.openInputStream(Uri.parse(file.contentUrl))?.use { it.readBytes() }
          ?: throw IllegalStateException("Could not open the downloaded EPUB")
      }
      // The app's screen sets the server connection when it starts: without it (the watch started this) there is no server address
      if (DeviceManager.serverConnectionConfig == null) {
        DeviceManager.serverConnectionConfig = DeviceManager.getServerConnectionConfig(DeviceManager.deviceData.lastServerConnectionConfigId)
      }
      if (DeviceManager.serverConnectionConfig == null) throw IllegalStateException("Log in to the server in the app first")
      // The access token can have expired: asking the server for the user refreshes it when it has
      val latch = java.util.concurrent.CountDownLatch(1)
      ApiHandler(context).getCurrentUser { latch.countDown() }
      latch.await(15, java.util.concurrent.TimeUnit.SECONDS)
      val request = Request.Builder().url("${DeviceManager.serverAddress}${input.getString("url")}").addHeader("Authorization", "Bearer ${DeviceManager.token}").build()
      http.newCall(request).execute().use { response ->
        if (!response.isSuccessful) throw IllegalStateException("The server answered ${response.code}")
        return response.body?.bytes() ?: throw IllegalStateException("The server sent no book")
      }
    }

    /** Same as AbsDatabase.updateLocalEbookProgress */
    private fun updateLocalEbookProgress(input: JSONObject): JSONObject {
      val localLibraryItemId = input.optString("localLibraryItemId")
      val ebookLocation = input.optString("ebookLocation")
      val ebookProgress = input.optDouble("ebookProgress", 0.0)
      var progress = DeviceManager.dbManager.getLocalMediaProgress(localLibraryItemId)
      if (progress == null) {
        val item = DeviceManager.dbManager.getLocalLibraryItem(localLibraryItemId) ?: return JSONObject()
        val book = item.media as Book
        progress = LocalMediaProgress(
          id = localLibraryItemId, localLibraryItemId = localLibraryItemId, localEpisodeId = null, duration = book.duration ?: 0.0,
          progress = 0.0, currentTime = 0.0, isFinished = false, ebookLocation = ebookLocation, ebookProgress = ebookProgress,
          lastUpdate = System.currentTimeMillis(), startedAt = 0L, finishedAt = null, serverConnectionConfigId = item.serverConnectionConfigId,
          serverAddress = item.serverAddress, serverUserId = item.serverUserId, libraryItemId = item.libraryItemId, episodeId = null
        )
      } else {
        progress.updateEbookProgress(ebookLocation, ebookProgress)
      }
      DeviceManager.dbManager.saveLocalMediaProgress(progress)
      return JSONObject()
    }
  }
}
