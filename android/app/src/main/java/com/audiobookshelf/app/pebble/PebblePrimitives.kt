package com.audiobookshelf.app.pebble

import android.content.Context
import android.media.AudioManager
import android.util.Log
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.server.ApiHandler
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The primitives the shared Pebble logic (`utils/pebble/hub.js`, run by [PebbleHost]) calls, by name. This is all the native
 * side of the watch support apart from moving messages: each one does one small thing and decides nothing. The list of them,
 * with what they return, is at the top of hub.js: an iOS version implements the same list.
 */
class PebblePrimitives(private val context: Context) {
  private val tag = "PebblePrimitives"
  private val audio = AudioPrimitives(context)
  private val tts = TtsPrimitives(context)
  private val http = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()

  fun release() = audio.release()

  /** Runs [method] (like "audio.state") with [input]; the result goes back to the page as JSON */
  suspend fun call(method: String, input: JSONObject): Any? = when (method) {
    "audio.state" -> audio.state()
    "audio.playPause" -> audio.playPause()
    "audio.pause" -> audio.pause()
    "audio.jump" -> audio.jump(input.optBoolean("forward"))
    "audio.setSpeed" -> audio.setSpeed(input.optDouble("speed", 1.0).toFloat())
    "audio.start" -> audio.start(input.optString("libraryItemId").ifEmpty { null }, input.optString("localLibraryItemId").ifEmpty { null })
    "audio.awaitPlaying" -> audio.awaitPlaying()
    "tts.state" -> tts.state()
    "tts.playPause" -> tts.playPause()
    "tts.pause" -> tts.pause()
    "tts.skip" -> tts.skip(input.optBoolean("forward"))
    "tts.setRate" -> tts.setRate(input.optDouble("rate", 1.0).toFloat())
    "tts.resume" -> tts.resume(input.optString("session"))
    "tts.startNew" -> tts.startNew(input.toString())
    "device.volume" -> volume()
    "device.adjustVolume" -> adjustVolume(input.optInt("direction"))
    "api.get" -> get(input.optString("path"))
    "api.lastLibraryId" -> context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("lastLibraryId", null)?.takeIf { it.isNotBlank() }
    "local.books" -> localBooks()
    "local.ebookProgress" -> ebookProgress(input.optString("id"))
    "pebble.send" -> PebbleListenerService.send(input.getJSONArray("items"))
    else -> throw IllegalArgumentException("Unknown primitive $method")
  }

  private fun volume(): Int = (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).getStreamVolume(AudioManager.STREAM_MUSIC)

  private fun adjustVolume(direction: Int) {
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    try {
      manager.adjustStreamVolume(AudioManager.STREAM_MUSIC, if (direction > 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
    } catch (e: SecurityException) {
      Log.w(tag, "Could not change the volume", e)
    }
  }

  /** A GET to the signed-in server. The app's screen sets the server connection when it starts: without it (the watch started this) use the last one. */
  private fun get(path: String): JSONObject {
    if (DeviceManager.serverConnectionConfig == null) {
      DeviceManager.serverConnectionConfig = DeviceManager.getServerConnectionConfig(DeviceManager.deviceData.lastServerConnectionConfigId)
    }
    if (DeviceManager.serverConnectionConfig == null || !DeviceManager.checkConnectivity(context)) return JSONObject().put("ok", false)
    // The access token can have expired: asking the server for the user refreshes it when it has
    val latch = CountDownLatch(1)
    ApiHandler(context).getCurrentUser { latch.countDown() }
    latch.await(15, TimeUnit.SECONDS)
    val request = Request.Builder().url("${DeviceManager.serverAddress}$path").addHeader("Authorization", "Bearer ${DeviceManager.token}").build()
    http.newCall(request).execute().use { response ->
      val body = response.body?.string().orEmpty()
      if (!response.isSuccessful) return JSONObject().put("ok", false).put("status", response.code)
      val json: Any = runCatching { if (body.trimStart().startsWith("[")) JSONArray(body) else JSONObject(body) }.getOrDefault(JSONObject())
      return JSONObject().put("ok", true).put("json", json)
    }
  }

  private fun localBooks(): JSONArray {
    val out = JSONArray()
    DeviceManager.dbManager.getLocalLibraryItems("book").forEach { item ->
      out.put(
        JSONObject().put("id", item.id).put("libraryItemId", item.libraryItemId ?: JSONObject.NULL).put("title", item.title)
          .put("hasAudio", item.media.checkHasTracks()).put("hasEpub", item.localFiles.any { it.mimeType == "application/epub+zip" })
      )
    }
    return out
  }

  private fun ebookProgress(id: String): Any {
    val progress = DeviceManager.dbManager.getLocalMediaProgress(id) ?: return JSONObject.NULL
    return JSONObject().put("ebookLocation", progress.ebookLocation ?: "").put("ebookProgress", progress.ebookProgress ?: 0.0)
  }
}
