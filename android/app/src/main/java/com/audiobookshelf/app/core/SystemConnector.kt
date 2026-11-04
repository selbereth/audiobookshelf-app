package com.audiobookshelf.app.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import org.json.JSONObject

/** `system.deviceInfo`, `system.appVersion`, `system.network`: facts from Android, nothing decided here. */
class SystemConnector(private val context: Context) : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "deviceInfo" -> reply(true, JSONObject().put("platform", "android").put("sdk", Build.VERSION.SDK_INT).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).toString())
      "appVersion" -> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        reply(true, JSONObject().put("versionName", info.versionName).put("versionCode", info.longVersionCode).put("packageName", context.packageName).toString())
      }
      "network" -> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        reply(true, JSONObject()
          .put("connected", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
          .put("metered", !(caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ?: false))
          .put("wifi", caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true).toString())
      }
      else -> reply(false, "unknown system.$method")
    }
  }
}
