package com.audiobookshelf.app.core

import android.content.Context
import com.audiobookshelf.app.managers.SecureStorage
import org.json.JSONObject

/** `secure`: Keystore-encrypted secrets. get({key}) -> {value: string | null}, put({key, value}) -> {stored}, delete({key}) -> {removed}. */
class SecureConnector(context: Context) : Connector {
  private val storage = SecureStorage(context)

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    val key = args.getString("key")
    when (method) {
      "get" -> reply(true, JSONObject().put("value", storage.getRefreshToken(key) ?: JSONObject.NULL).toString())
      "put" -> reply(true, JSONObject().put("stored", storage.storeRefreshToken(key, args.getString("value"))).toString())
      "delete" -> reply(true, JSONObject().put("removed", storage.removeRefreshToken(key)).toString())
      else -> reply(false, "unknown secure.$method")
    }
  }
}
