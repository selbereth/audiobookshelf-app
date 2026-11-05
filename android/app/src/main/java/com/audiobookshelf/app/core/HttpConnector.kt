package com.audiobookshelf.app.core

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * `http.request({method, url, headers, body, timeoutMs}) -> {status, headers, body}`. The page cannot call the server by `fetch`
 * (CORS), so every server call goes through here. No retry, no token handling: those are the core's job.
 */
class HttpConnector : Connector {
  private val client = OkHttpClient()

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method != "request") return reply(false, "unknown http.$method")
    thread {
      try {
        val http = client.newBuilder().callTimeout(args.optLong("timeoutMs", 30000), TimeUnit.MILLISECONDS).build()
        val b = Request.Builder().url(args.getString("url"))
        args.optJSONObject("headers")?.let { h -> h.keys().forEach { k -> b.addHeader(k, h.getString(k)) } }
        val verb = args.optString("method", "GET").uppercase()
        val body = if (args.has("body") && !args.isNull("body")) {
          args.get("body").let { if (it is String) it else it.toString() }.toRequestBody(args.optString("contentType", "application/json").toMediaTypeOrNull())
        } else if (verb == "POST" || verb == "PUT" || verb == "PATCH") "".toRequestBody(null) else null
        http.newCall(b.method(verb, body).build()).execute().use { r ->
          val headers = JSONObject()
          r.headers.names().forEach { n -> headers.put(n, r.header(n)) }
          reply(true, JSONObject().put("status", r.code).put("headers", headers).put("body", r.body?.string() ?: "").toString())
        }
      } catch (e: Exception) {
        reply(false, e.message ?: "request failed")
      }
    }
  }
}
