package com.audiobookshelf.app.core

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File

/**
 * `files` (grows in Phase 8): `exists({contentUrl} | {path}) -> {exists}`. A content: url is opened through the content resolver,
 * a path is a plain file. Which one to ask about is the core's decision.
 */
class FilesConnector(private val context: Context) : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method != "exists") return reply(false, "unknown files.$method")
    val exists = if (args.has("contentUrl")) {
      try {
        context.contentResolver.openFileDescriptor(Uri.parse(args.getString("contentUrl")), "r")?.use { true } ?: false
      } catch (e: Exception) {
        false
      }
    } else File(args.getString("path")).exists()
    reply(true, JSONObject().put("exists", exists).toString())
  }
}
