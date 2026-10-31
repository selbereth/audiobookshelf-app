package com.audiobookshelf.app.pebble

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Runs the shared Pebble logic (`utils/pebble/hub.js`, bundled into assets/pebble-hub) in a WebView nobody sees, so it works with
 * the app's screen closed. Both directions are plain JSON: native calls a function of the page ([call]), and the page calls the
 * primitives of [PebblePrimitives] by name. Nothing here knows what a message means.
 */
object PebbleHost {
  private const val TAG = "PebbleHost"
  private val main = Handler(Looper.getMainLooper())
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var webView: WebView? = null
  /** Completes when the page has loaded; a new one is made when the page is stopped, never while a caller may be waiting on it */
  @Volatile private var loaded = CompletableDeferred<Unit>()
  private var primitives: PebblePrimitives? = null
  private val nextId = AtomicInteger(1)
  private val waiting = ConcurrentHashMap<Int, CompletableDeferred<String?>>()

  /** Starts the page (once). Safe to call again. */
  @SuppressLint("SetJavaScriptEnabled")
  fun start(context: Context) {
    main.post {
      if (webView != null) return@post
      val app = context.applicationContext
      primitives = PebblePrimitives(app)
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
      view.addJavascriptInterface(Bridge(), "NativeHub")
      view.webViewClient = object : WebViewClient() {
        override fun onPageFinished(page: WebView, url: String?) {
          loaded.complete(Unit)
        }
      }
      view.loadUrl("file:///android_asset/pebble-hub/index.html")
    }
  }

  fun stop() {
    main.post {
      val view = webView ?: return@post
      webView = null
      runCatching {
        view.removeJavascriptInterface("NativeHub")
        view.destroy()
      }
      primitives?.release()
      primitives = null
      loaded = CompletableDeferred()
      waiting.values.forEach { it.complete(null) }
      waiting.clear()
    }
  }

  /**
   * Calls `pebbleHub[function](...args)` in the page and waits for what it returns (JSON, or null). Null as well when the page
   * fails or does not answer within [timeoutMs].
   */
  suspend fun call(context: Context, function: String, args: JSONArray = JSONArray(), timeoutMs: Long = 120_000): String? {
    start(context)
    loaded.await()
    val id = nextId.getAndIncrement()
    val answer = CompletableDeferred<String?>()
    waiting[id] = answer
    main.post {
      webView?.evaluateJavascript("pebbleHub.run($id, ${JSONObject.quote(function)}, ${JSONObject.quote(args.toString())})", null)
    }
    return withTimeoutOrNull(timeoutMs) { answer.await() }.also { waiting.remove(id) }
  }

  private class Bridge {
    /** The page calls a primitive: the answer goes back through `window.__hubReply` */
    @JavascriptInterface
    fun invoke(method: String, args: String, id: Int) {
      scope.launch {
        val view = webView
        fun reply(ok: Boolean, json: String) {
          main.post { view?.evaluateJavascript("window.__hubReply($id, $ok, ${JSONObject.quote(json)})", null) }
        }
        try {
          val result = primitives?.call(method, JSONObject(args))
          reply(true, if (result == null || result === Unit) "" else if (result is String) JSONObject.quote(result) else result.toString())
        } catch (e: Exception) {
          Log.e(TAG, "$method failed", e)
          reply(false, e.message ?: "failed")
        }
      }
    }

    /** The page finished a [call] */
    @JavascriptInterface
    fun done(id: Int, ok: Boolean, json: String) {
      waiting[id]?.complete(if (ok) json else null)
    }
  }
}
