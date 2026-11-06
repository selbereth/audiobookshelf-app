package com.audiobookshelf.app.core

import com.audiobookshelf.app.managers.DbManager
import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The hidden web view that runs the JS core (assets/core, built from utils/core by `npm run build:core`). The player service,
 * the UI activity and the other services start it and it lives as long as the process. Native only moves JSON:
 *  - calls down from JS go to a registered [Connector] ([register]);
 *  - events up ([emit]) are stamped with the time they happened and delivered in order;
 *  - calls up ([callUp]) ask JS and wait, with a timeout, for the answer (Android Auto browse, UI commands).
 * While the page starts or restarts (renderer crash) events and calls up are queued and replayed in order when the core says it
 * is ready. Playback never waits for this: ExoPlayer keeps playing on its own.
 */
object CoreHost {
  private const val TAG = "CoreHost"
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var app: Context? = null
  @Volatile private var ready = false
  private var startedAt = 0L
  private val queue = ArrayDeque<() -> Unit>()
  private val connectors = ConcurrentHashMap<String, Connector>()
  private val nextUpId = AtomicInteger(1)
  private val waitingUp = ConcurrentHashMap<Int, (Boolean, String) -> Unit>()

  val isReady get() = ready

  fun register(name: String, connector: Connector) {
    connectors[name] = connector
  }

  /** Starts the page (once, safe to call again). The page is loaded as http://localhost/core/index.html, the UI's origin. */
  fun start(context: Context) {
    main.post {
      if (webView != null) return@post
      app = context.applicationContext
      // The core reads the device data from the store, so every process that starts the core opens the database the way the
      // app does (idempotent). Without this a process started from a service, not the UI, had no store.
      DbManager.initialize(app!!)
      registerDefaults(app!!)
      create()
    }
  }

  private fun registerDefaults(context: Context) {
    register("http", HttpConnector())
    register("wake", WakeConnector(context))
    register("timer", TimerConnector())
    register("system", SystemConnector(context))
    register("ui", UiConnector())
    register("store", StoreConnector())
    register("secure", SecureConnector(context))
    register("files", FilesConnector(context))
    register("device", DeviceConnector())
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun create() {
    val context = app ?: return
    ready = false
    startedAt = SystemClock.elapsedRealtime()
    val assets = WebViewAssetLoader.AssetsPathHandler(context)
    val loader = WebViewAssetLoader.Builder().setDomain("localhost").setHttpAllowed(true)
      .addPathHandler("/core/") { path -> assets.handle("core/$path") }.build()
    val view = WebView(context)
    webView = view
    view.settings.javaScriptEnabled = true
    view.webChromeClient = object : WebChromeClient() {
      override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        Log.i(TAG, m.message())
        return true
      }
    }
    view.addJavascriptInterface(Bridge(), "NativeCore")
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
        loader.shouldInterceptRequest(request.url)

      override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
        Log.w(TAG, "renderer gone crashed=${detail.didCrash()}: restarting, ${queue.size} queued")
        main.post {
          runCatching { v.destroy() }
          webView = null
          // Nobody can answer these now; events stay queued and are replayed to the new page
          waitingUp.keys.toList().forEach { id -> waitingUp.remove(id)?.invoke(false, "core restarted") }
          create()
        }
        return true // handled: the app process stays alive
      }
    }
    view.loadUrl("http://localhost/core/index.html")
  }

  fun stop() = main.post {
    webView?.let { runCatching { it.removeJavascriptInterface("NativeCore"); it.destroy() } }
    webView = null
    ready = false
  }

  /** Native -> JS event. Safe from any thread. The time is taken now, not at delivery. */
  fun emit(connector: String, event: String, data: JSONObject = JSONObject()) {
    val t = System.currentTimeMillis()
    val json = data.toString()
    post {
      webView?.evaluateJavascript(
        "window.__core.event(${JSONObject.quote(connector)}, ${JSONObject.quote(event)}, ${JSONObject.quote(json)}, $t)", null
      )
    }
  }

  /**
   * Native asks JS and waits. [callback] gets the JSON answer, or ok=false with a message (no server, JS error, [timeoutMs] passed,
   * core restarted). The timeout counts from now, also while the core is still starting.
   */
  fun callUp(connector: String, method: String, args: JSONObject, timeoutMs: Long, callback: (ok: Boolean, json: String) -> Unit) {
    val id = nextUpId.getAndIncrement()
    val json = args.toString()
    main.post {
      waitingUp[id] = callback
      main.postDelayed({ waitingUp.remove(id)?.invoke(false, "timeout") }, timeoutMs)
      post {
        if (!waitingUp.containsKey(id)) return@post // timed out while queued
        webView?.evaluateJavascript(
          "window.__core.callUp($id, ${JSONObject.quote(connector)}, ${JSONObject.quote(method)}, ${JSONObject.quote(json)})", null
        )
      }
    }
  }

  /** Runs [work] now when the core is ready, else queues it (in order) for when it is. Main thread only. */
  private fun post(work: () -> Unit) {
    main.post { if (ready) work() else queue.addLast(work) }
  }

  /** Test hook (debug receiver): crashes the renderer the way Chromium documents for testing onRenderProcessGone */
  fun crashForTest() = main.post { webView?.loadUrl("chrome://crash") }

  private fun reply(id: Int, ok: Boolean, json: String = "") = main.post {
    webView?.evaluateJavascript("window.__core.reply($id, $ok, ${JSONObject.quote(json)})", null)
  }

  private class Bridge {
    @JavascriptInterface
    fun ready() {
      main.post {
        ready = true
        Log.i(TAG, "READY after ${SystemClock.elapsedRealtime() - startedAt} ms, replaying ${queue.size} queued")
        while (queue.isNotEmpty()) queue.removeFirst().invoke()
      }
    }

    @JavascriptInterface
    fun call(connector: String, method: String, args: String, id: Int) {
      val c = connectors[connector]
      if (c == null) {
        reply(id, false, "no connector $connector")
        return
      }
      try {
        c.call(method, JSONObject(args)) { ok, json -> reply(id, ok, json) }
      } catch (e: Exception) {
        Log.e(TAG, "$connector.$method failed", e)
        reply(id, false, e.message ?: "failed")
      }
    }

    @JavascriptInterface
    fun answerUp(id: Int, ok: Boolean, json: String) {
      main.post { waitingUp.remove(id)?.invoke(ok, json) }
    }
  }
}
