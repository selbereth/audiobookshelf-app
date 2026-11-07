package com.audiobookshelf.app.core

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.provider.Settings
import com.audiobookshelf.app.BuildConfig
import com.audiobookshelf.app.device.DeviceManager
import org.json.JSONObject

/** `system.deviceInfo`, `system.appVersion`, `system.network`, `system.flags`: facts from Android, nothing decided here. */
class SystemConnector(private val context: Context) : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "deviceInfo" -> {
        @SuppressLint("HardwareIds")
        val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
        reply(true, JSONObject().put("platform", "android").put("sdk", Build.VERSION.SDK_INT).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
          .put("deviceId", deviceId).put("versionName", BuildConfig.VERSION_NAME).toString())
      }
      "appVersion" -> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        reply(true, JSONObject().put("versionName", info.versionName).put("versionCode", info.longVersionCode).put("packageName", context.packageName).toString())
      }
      "network" -> reply(true, networkFacts(context).toString())
      "flags" -> reply(true, JSONObject().put("coreSaver", CoreSwitch.coreSaver).put("coreSleep", CoreSwitch.coreSleep).put("coreUi", CoreSwitch.coreUi).put("corePebble", CoreSwitch.corePebble).toString())
      else -> reply(false, "unknown system.$method")
    }
  }

  companion object {
    private var watching = false

    /**
     * {connected, metered, wifi, validated} of the active network. `connected` is the value Kotlin's save path uses
     * (DeviceManager.checkConnectivity: any cellular, wifi or ethernet transport), not the VALIDATED rule.
     */
    fun networkFacts(context: Context): JSONObject {
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.getNetworkCapabilities(cm.activeNetwork)
      return JSONObject()
        .put("connected", DeviceManager.checkConnectivity(context))
        .put("metered", !(caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ?: false))
        .put("wifi", caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true)
        .put("validated", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
    }

    /**
     * Emits `system network` on every change of the network, metered or not (the app's own callback only asks for unmetered
     * networks). Registered once per process; the core asks for the current value at start (`system.network`).
     */
    fun watchNetwork(context: Context) {
      if (watching) return
      watching = true
      val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val request = NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build()
      cm.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = CoreHost.emit("system", "network", networkFacts(context))
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = CoreHost.emit("system", "network", networkFacts(context))
        override fun onLost(network: Network) = CoreHost.emit("system", "network", networkFacts(context))
      })
    }
  }
}
