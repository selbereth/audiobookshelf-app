package com.audiobookshelf.app.plugins

import android.content.Intent
import androidx.core.content.FileProvider
import com.audiobookshelf.app.debug.DebugLog
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** The "Enable debug logs" setting and the "Share debug logs" button (see [DebugLog]). */
@CapacitorPlugin(name = "AbsDebugLog")
class AbsDebugLog : Plugin() {
  private fun state(): JSObject {
    val s = DebugLog.stats(context)
    return JSObject().put("enabled", s.enabled).put("days", s.days).put("bytes", s.bytes)
  }

  @PluginMethod
  fun getDebugLogs(call: PluginCall) {
    call.resolve(state())
  }

  @PluginMethod
  fun setDebugLogsEnabled(call: PluginCall) {
    val on = call.getBoolean("enabled") ?: return call.reject("No enabled")
    DebugLog.setEnabled(context, on)
    call.resolve(state())
  }

  @PluginMethod
  fun shareDebugLogs(call: PluginCall) {
    Thread {
      try {
        val zip = DebugLog.buildShareZip(context) ?: return@Thread call.reject("No logs yet")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", zip)
        val send = Intent(Intent.ACTION_SEND)
          .setType("application/zip")
          .putExtra(Intent.EXTRA_STREAM, uri)
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.runOnUiThread {
          activity.startActivity(Intent.createChooser(send, "Share debug logs"))
          call.resolve()
        }
      } catch (e: Exception) {
        call.reject("Could not share the debug logs: ${e.message}")
      }
    }.start()
  }
}
