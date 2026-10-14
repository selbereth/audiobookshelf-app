package com.audiobookshelf.app.plugins

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.player.PlayerNotificationService
import com.audiobookshelf.app.tts.TtsController
import com.audiobookshelf.app.tts.TtsHeadless
import com.audiobookshelf.app.tts.TtsSentence
import com.audiobookshelf.app.tts.TtsService
import com.audiobookshelf.app.tts.TtsSnapshot
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AbsTts")
class AbsTts : Plugin() {
  private val main = Handler(Looper.getMainLooper())

  // Settings captured at start() and applied once the service has its controller
  private var pendingStreamId = 0

  private val listener = object : TtsController.Listener {
    override fun onSentence(s: TtsSentence) {
      notifyListeners("sentence", JSObject().put("id", s.id).put("cfi", s.cfi).put("spine", s.spine))
    }
    override fun onState(playing: Boolean, reason: String?) {
      notifyListeners("state", JSObject().put("playing", playing).put("reason", reason))
    }
    override fun onNeedMore(streamId: Int, lastSeq: Int) {
      notifyListeners("needMore", JSObject().put("streamId", streamId).put("lastSeq", lastSeq))
    }
    override fun onEnded() { notifyListeners("ended", JSObject()) }
    override fun onWord(id: Int, start: Int, end: Int) {
      notifyListeners("word", JSObject().put("id", id).put("start", start).put("end", end))
    }
    override fun onSleepTimer(remainingMs: Long, running: Boolean, atChapterEnd: Boolean) {
      notifyListeners("sleepTimer", JSObject().put("remainingMs", remainingMs).put("running", running).put("atChapterEnd", atChapterEnd))
    }
    override fun onError(code: String, message: String) {
      notifyListeners("error", JSObject().put("code", code).put("message", message))
    }
  }

  override fun load() {
    // The app's screen opens while the hidden read-aloud runs: the screen takes over (the reading stops where it is)
    if (TtsHeadless.isRunning) TtsHeadless.handOver()
    TtsService.eventListener = listener
  }

  private val svc get() = TtsService.instance

  @PluginMethod
  fun start(call: PluginCall) {
    TtsService.eventListener = listener
    // Only one thing owns media playback: pause the audiobook player
    try {
      if (PlayerNotificationService.isStarted) (activity as? MainActivity)?.foregroundService?.pause()
    } catch (e: Exception) {
      android.util.Log.w("AbsTts", "Failed to pause audiobook player: $e")
    }
    pendingStreamId = call.getInt("streamId", 0) ?: 0
    val intent = Intent(context, TtsService::class.java).apply {
      action = TtsService.ACTION_START
      putExtra(TtsService.EXTRA_TITLE, call.getString("title", ""))
      putExtra(TtsService.EXTRA_AUTHOR, call.getString("author", ""))
      putExtra(TtsService.EXTRA_COVER_URI, call.getString("coverUri", ""))
    }
    ContextCompat.startForegroundService(context, intent)

    val lang = call.getString("lang")
    val voiceId = call.getString("voiceId")
    val rate = call.getFloat("rate", 1f) ?: 1f
    val pitch = call.getFloat("pitch", 1f) ?: 1f
    // The service is created asynchronously; poll briefly for it
    var tries = 0
    val apply = object : Runnable {
      override fun run() {
        val s = svc
        if (s == null) {
          if (tries++ < 50) main.postDelayed(this, 50) else call.reject("TTS service failed to start")
          return
        }
        s.controller.apply {
          reset(pendingStreamId)
          this.lang = lang
          this.voiceId = voiceId
          this.rate = rate
          this.pitch = pitch
          updateVoice()
        }
        call.resolve()
      }
    }
    main.post(apply)
  }

  @PluginMethod
  fun appendChunk(call: PluginCall) {
    val s = svc ?: return call.reject("No TTS session")
    val arr = call.getArray("sentences") ?: JSArray()
    val list = ArrayList<TtsSentence>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      list.add(TtsSentence(o.getInt("id"), o.getString("text"), o.getString("cfi"), o.optInt("spine"), o.optInt("paragraph")))
    }
    s.controller.appendChunk(call.getInt("streamId", 0) ?: 0, call.getInt("seq", 0) ?: 0, list, call.getBoolean("done", false) ?: false, if (call.hasOption("startId")) call.getInt("startId") else null)
    call.resolve()
  }

  @PluginMethod
  fun prependChunk(call: PluginCall) {
    val s = svc ?: return call.reject("No TTS session")
    val arr = call.getArray("sentences") ?: JSArray()
    val list = ArrayList<TtsSentence>(arr.length())
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      list.add(TtsSentence(o.getInt("id"), o.getString("text"), o.getString("cfi"), o.optInt("spine"), o.optInt("paragraph")))
    }
    s.controller.prependChunk(call.getInt("streamId", 0) ?: 0, list)
    call.resolve()
  }

  @PluginMethod
  fun play(call: PluginCall) {
    main.post { svc?.startPlayback(); call.resolve() }
  }

  @PluginMethod
  fun pause(call: PluginCall) {
    svc?.controller?.pause()
    call.resolve()
  }

  @PluginMethod
  fun stop(call: PluginCall) {
    TtsService.requestStop()
    call.resolve()
  }

  @PluginMethod
  fun skip(call: PluginCall) {
    svc?.controller?.skip(call.getString("by", "sentence") ?: "sentence", call.getInt("count", 1) ?: 1)
    call.resolve()
  }

  @PluginMethod
  fun seekToSentence(call: PluginCall) {
    val ok = svc?.controller?.seekToSentence(call.getInt("id", -1) ?: -1) ?: false
    call.resolve(JSObject().put("found", ok))
  }

  @PluginMethod
  fun reset(call: PluginCall) {
    svc?.controller?.reset(call.getInt("streamId", 0) ?: 0)
    call.resolve()
  }

  @PluginMethod
  fun setRate(call: PluginCall) {
    svc?.controller?.updateVoice(newRate = call.getFloat("rate", 1f))
    call.resolve()
  }

  @PluginMethod
  fun setPitch(call: PluginCall) {
    svc?.controller?.updateVoice(newPitch = call.getFloat("pitch", 1f))
    call.resolve()
  }

  @PluginMethod
  fun setVoice(call: PluginCall) {
    svc?.controller?.updateVoice(newVoiceId = call.getString("voiceId", "") ?: "")
    call.resolve()
  }

  @PluginMethod
  fun setSleepTimer(call: PluginCall) {
    val s = svc ?: return call.reject("No TTS session")
    if (call.getBoolean("endOfChapter", false) == true) {
      // JS sends a very large number for "no later chapter": the end of the book
      val until = call.data.optLong("untilSpine", -1L)
      s.setSleepAtChapterEnd(if (until < 0) null else until.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
    } else {
      s.setSleepTimer(call.data.optLong("ms", 0L))
    }
    call.resolve()
  }

  @PluginMethod
  fun adjustSleepTimer(call: PluginCall) {
    svc?.adjustSleepTimer(call.data.optLong("ms", 0L))
    call.resolve()
  }

  @PluginMethod
  fun cancelSleepTimer(call: PluginCall) {
    svc?.cancelSleepTimer()
    call.resolve()
  }

  /** The sentence being spoken with some before and after it: the text view of the player shows them */
  @PluginMethod
  fun getWindow(call: PluginCall) {
    val sentences = svc?.controller?.window(call.getInt("before", 1) ?: 1, call.getInt("after", 30) ?: 30) ?: emptyList()
    val arr = JSArray()
    sentences.forEach { arr.put(JSObject().put("id", it.id).put("text", it.text).put("paragraph", it.paragraph)) }
    call.resolve(JSObject().put("sentences", arr).put("currentId", svc?.controller?.currentSentence?.id))
  }

  @PluginMethod
  fun getVoices(call: PluginCall) {
    val voices = JSArray()
    svc?.controller?.getVoices(call.getString("lang"))?.forEach {
      voices.put(JSObject().put("id", it.name).put("name", it.name).put("lang", it.locale.toLanguageTag()).put("quality", it.quality).put("network", it.isNetworkConnectionRequired))
    }
    call.resolve(JSObject().put("voices", voices))
  }

  @PluginMethod
  fun saveSnapshot(call: PluginCall) {
    TtsSnapshot.save(
      context,
      TtsSnapshot(
        call.getString("libraryItemId") ?: return call.resolve(),
        call.getString("title") ?: "",
        call.getString("chapter") ?: "",
        call.getInt("chapterNumber", 0) ?: 0,
        call.getInt("chapterCount", 0) ?: 0,
        call.getDouble("progress") ?: 0.0,
        System.currentTimeMillis(),
        call.getString("session") ?: "",
        call.getDouble("chapterStart") ?: 0.0,
        call.getDouble("chapterEnd") ?: 0.0
      )
    )
    call.resolve()
  }

  @PluginMethod
  fun getSnapshot(call: PluginCall) {
    call.resolve(JSObject().put("session", TtsSnapshot.load(context)?.session ?: ""))
  }

  @PluginMethod
  fun clearSnapshot(call: PluginCall) {
    TtsSnapshot.clear(context)
    call.resolve()
  }

  @PluginMethod
  fun getState(call: PluginCall) {
    val c = svc?.controller
    val cur = c?.currentSentence
    call.resolve(
      JSObject().put("active", c != null).put("playing", c?.playing ?: false)
        .put("currentId", cur?.id).put("currentCfi", cur?.cfi)
        .put("streamId", c?.streamId ?: 0).put("lastSeq", c?.lastSeq ?: -1).put("bufferedCount", c?.bufferedCount ?: 0)
    )
  }
}
