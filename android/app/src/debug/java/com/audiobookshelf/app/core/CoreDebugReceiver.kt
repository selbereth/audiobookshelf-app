package com.audiobookshelf.app.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Debug builds only (Phase 0 spike):
 *   adb shell am broadcast -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.core.CoreDebugReceiver --es action start [--es mode asset|file]
 * actions: start, stop, timers (--ei sleepMs --ei durationMs), ticks (--ei seconds), cors (--es url http://server), crash is done with adb kill.
 */
class CoreDebugReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    when (intent.getStringExtra("action")) {
      "start" -> CoreHost.start(app)
      "paperCheck" -> Thread { PaperRoundTripCheck.run(app) }.start()
      "threads" -> Thread.getAllStackTraces().forEach { (t, st) ->
        if (t.name.startsWith("Thread-") || t.name == "main") Log.i("ThreadDump", "${t.name} ${t.state}\n" + st.take(14).joinToString("\n") { "    at $it" })
      }
      "call" -> {
        val method = intent.getStringExtra("method") ?: ""
        val started = System.currentTimeMillis()
        try {
          CoreHost.callUp("core", method, JSONObject(intent.getStringExtra("args") ?: "{}"), 60000) { ok, json ->
            Log.i("CoreDebug", "call $method ok=$ok ${System.currentTimeMillis() - started} ms ${json.take(intent.getIntExtra("max", 300))}")
          }
        } catch (e: Exception) {
          // Bad --es args (not JSON) must not crash the app process: log and drop the call
          Log.e("CoreDebug", "call $method rejected, bad args '${intent.getStringExtra("args")}': ${e.message}")
          return
        }
      }
      "kotlinView" -> Thread {
        val t0 = System.currentTimeMillis()
        com.audiobookshelf.app.managers.DbManager.initialize(app)
        val dm = com.audiobookshelf.app.device.DeviceManager
        Log.i("CoreDebug", "kotlinView settings.jumpForwardTime=${dm.deviceData.deviceSettings?.jumpForwardTime} configs=${dm.deviceData.serverConnectionConfigs.size} current=${dm.serverConnectionConfig?.id?.take(8)} items=${dm.dbManager.getLocalLibraryItems().size} progress=${dm.dbManager.getAllLocalMediaProgress().size} (${System.currentTimeMillis() - t0} ms)")
      }.start()
      "stop" -> CoreHost.stop()
      "crash" -> CoreHost.crashForTest()
      "timers" -> CoreHost.callUp("core", "timerTest", JSONObject().put("sleepMs", intent.getIntExtra("sleepMs", 60000)).put("durationMs", intent.getIntExtra("durationMs", 300000)), 5000) { _, _ -> }
      "cors" -> CoreHost.callUp("core", "httpTest", JSONObject().put("url", intent.getStringExtra("url") ?: ""), 20000) { _, _ -> }
      "ping" -> {
        val sent = System.currentTimeMillis()
        CoreHost.callUp("core", "ping", JSONObject(), 5000) { ok, json -> Log.i("CoreDebug", "ping ok=$ok $json roundTripMs=${System.currentTimeMillis() - sent}") }
      }
      "unknown" -> CoreHost.callUp("core", "nope", JSONObject(), 5000) { ok, json -> Log.i("CoreDebug", "unknown ok=$ok $json") }
      "timeout" -> CoreHost.callUp("core", "ping", JSONObject(), 1) { ok, json -> Log.i("CoreDebug", "timeout ok=$ok $json") }
      "ticks" -> {
        // Stand-in for the player's position ticks (the real ones come in Phase 4): one a second from a native Handler
        val seconds = intent.getIntExtra("seconds", 300)
        val h = Handler(Looper.getMainLooper())
        var n = 0
        h.post(object : Runnable {
          override fun run() {
            CoreHost.emit("player", "position", JSONObject().put("ms", n * 1000))
            if (++n < seconds) h.postDelayed(this, 1000)
          }
        })
      }
    }
    Log.i("CoreDebug", "handled ${intent.getStringExtra("action")}")
  }
}
