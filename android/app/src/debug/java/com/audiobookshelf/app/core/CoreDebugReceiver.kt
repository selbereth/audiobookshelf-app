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
      // Phase 4b-3 switch: which path saves progress. Applies at the next start of the app (force-stop, then start it)
      "coreSaver" -> {
        CoreSwitch.write(app, intent.getBooleanExtra("on", false))
        Log.i("CoreDebug", "coreSaver written on=${intent.getBooleanExtra("on", false)}: restart the app process for it to apply")
      }
      // Phase 5 switch: the core's sleep timer. Applies at the next start of the app, like coreSaver
      "coreSleep" -> {
        CoreSwitch.writeSleep(app, intent.getBooleanExtra("on", false))
        Log.i("CoreDebug", "coreSleep written on=${intent.getBooleanExtra("on", false)}: restart the app process for it to apply")
      }
      // Phase 6 switch: the UI mirrors the device data from the core. Applies at the next start of the app, like the others
      "coreUi" -> {
        CoreSwitch.writeUi(app, intent.getBooleanExtra("on", false))
        Log.i("CoreDebug", "coreUi written on=${intent.getBooleanExtra("on", false)}: restart the app process for it to apply")
      }
      // Phase 7 switch: the Pebble watch logic runs in the core. Applies at the next start of the app, like the others
      "corePebble" -> {
        CoreSwitch.writePebble(app, intent.getBooleanExtra("on", false))
        Log.i("CoreDebug", "corePebble written on=${intent.getBooleanExtra("on", false)}: restart the app process for it to apply")
      }
      // Phase 8 switch: the core decides download steps, retry counts and free space. Applies at the next start of the app
      "coreDownload" -> {
        CoreSwitch.writeDownload(app, intent.getBooleanExtra("on", false))
        Log.i("CoreDebug", "coreDownload written on=${intent.getBooleanExtra("on", false)}: restart the app process for it to apply")
      }
      // Phase 8 calls to the downloads connector: --es method partStep|retryOutcome|hasSpace, --es args '<json>'
      "downloads" -> {
        val method = intent.getStringExtra("method") ?: ""
        try {
          CoreHost.callUp("downloads", method, JSONObject(intent.getStringExtra("args") ?: "{}"), 5000) { ok, json -> Log.i("CoreDebug", "downloads.$method ok=$ok $json") }
        } catch (e: Exception) {
          Log.e("CoreDebug", "downloads.$method rejected, bad args: ${e.message}")
          return
        }
      }
      // Sleep timer calls to the core: --es method set|increase|decrease|cancel|resend, --el ms, --ez chapter
      "sleep" -> {
        val args = JSONObject().put("ms", intent.getLongExtra("ms", 0L)).put("isChapterTime", intent.getBooleanExtra("chapter", false)).put("sessionId", "debug")
        val method = intent.getStringExtra("method") ?: ""
        CoreSleep.call(method, args) { ok, json -> Log.i("CoreDebug", "sleep.$method ok=$ok $json") }
      }
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
