package com.audiobookshelf.app.tts

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale

data class TtsSentence(val id: Int, val text: String, val cfi: String, val spine: Int, val paragraph: Int)

/**
 * Native sentence store + feeder loop. Once sentences are here, playback does not depend on JS.
 * Listener callbacks are invoked on arbitrary threads.
 */
class TtsController(private val context: Context) {
  interface Listener {
    fun onSentence(s: TtsSentence)
    fun onState(playing: Boolean, reason: String?)
    fun onNeedMore(streamId: Int, lastSeq: Int)
    fun onEnded()
    fun onError(code: String, message: String)
  }

  private val tag = "TtsController"
  private val window = 12
  private val lock = Any()

  var listener: Listener? = null
  var streamId = 0
  var lastSeq = -1
  var streamDone = false
  var rate = 1.0f
  var pitch = 1.0f
  var lang: String? = null
  var voiceId: String? = null

  private val store = ArrayList<TtsSentence>()
  private var cursor = 0          // index of the sentence currently speaking (or next to speak)
  private var nextToQueue = 0     // index of next sentence to hand to the engine
  private val queued = LinkedHashSet<Int>() // sentence ids in the engine queue
  var playing = false
    private set
  private var wantPlaying = false
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private var needMoreSentFor = -1

  val currentSentence: TtsSentence? get() = synchronized(lock) { store.getOrNull(cursor) }
  val bufferedCount: Int get() = synchronized(lock) { store.size - cursor }

  fun init() {
    if (engine != null) return
    engine = TextToSpeech(context.applicationContext) { status ->
      if (status != TextToSpeech.SUCCESS) {
        listener?.onError("engine_unavailable", "Text-to-speech engine failed to initialize")
        return@TextToSpeech
      }
      engine?.setOnUtteranceProgressListener(progressListener)
      engineReady = true
      applyVoiceSettings()
      synchronized(lock) { if (wantPlaying) refill() }
    }
  }

  private fun applyVoiceSettings() {
    val e = engine ?: return
    if (!engineReady) return // applied again from the init callback
    e.setSpeechRate(rate)
    e.setPitch(pitch)
    val v = voiceId?.let { id -> e.voices?.firstOrNull { it.name == id } }
    if (v != null) {
      e.voice = v
    } else if (!lang.isNullOrBlank()) {
      val result = e.setLanguage(Locale.forLanguageTag(lang!!))
      if (result == TextToSpeech.LANG_MISSING_DATA || result == TextToSpeech.LANG_NOT_SUPPORTED) {
        Log.e(tag, "setLanguage($lang) result=$result")
        listener?.onError("language_unsupported", "No voice available for language $lang")
      }
    }
  }

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      val id = utteranceId?.toIntOrNull() ?: return
      var sentence: TtsSentence? = null
      synchronized(lock) {
        val idx = store.indexOfFirst { it.id == id }
        if (idx >= 0) {
          cursor = idx
          sentence = store[idx]
        }
      }
      sentence?.let { listener?.onSentence(it) }
    }

    override fun onDone(utteranceId: String?) {
      val id = utteranceId?.toIntOrNull() ?: return
      var ended = false
      var needMore = false
      synchronized(lock) {
        if (!queued.remove(id)) return // flushed/stale
        val idx = store.indexOfFirst { it.id == id }
        if (idx >= 0) cursor = minOf(idx + 1, store.size)
        if (wantPlaying) refill()
        if (queued.isEmpty() && nextToQueue >= store.size) {
          if (streamDone) {
            ended = true
            wantPlaying = false
            playing = false
          }
        }
        if (!streamDone && store.size - cursor < 2 * 50 && needMoreSentFor != lastSeq) {
          needMoreSentFor = lastSeq
          needMore = true
        }
      }
      if (needMore) listener?.onNeedMore(streamId, lastSeq)
      if (ended) listener?.onEnded()
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      Log.e(tag, "utterance error $utteranceId")
      listener?.onError("utterance_error", "Failed to speak sentence")
    }
  }

  /** Must be called with lock held */
  private fun refill() {
    val e = engine ?: return
    if (!engineReady) return
    while (queued.size < window && nextToQueue < store.size) {
      val s = store[nextToQueue++]
      queued.add(s.id)
      val params = Bundle()
      e.speak(s.text, TextToSpeech.QUEUE_ADD, params, s.id.toString())
    }
  }

  /** Must be called with lock held */
  private fun flushEngine() {
    engine?.stop()
    queued.clear()
    nextToQueue = cursor
  }

  fun appendChunk(sid: Int, seq: Int, sentences: List<TtsSentence>, done: Boolean) {
    synchronized(lock) {
      if (sid != streamId || seq <= lastSeq) return
      lastSeq = seq
      store.addAll(sentences)
      if (done) streamDone = true
      if (wantPlaying) refill()
    }
  }

  fun play() {
    synchronized(lock) {
      wantPlaying = true
      playing = true
      // resume from cursor
      flushEngine()
      refill()
    }
    listener?.onState(true, null)
  }

  fun pause(reason: String? = null) {
    synchronized(lock) {
      wantPlaying = false
      playing = false
      flushEngine()
    }
    listener?.onState(false, reason)
  }

  fun skip(by: String, count: Int) {
    synchronized(lock) {
      var target = cursor
      if (by == "paragraph") {
        val cur = store.getOrNull(cursor)?.paragraph ?: 0
        if (count > 0) {
          var idx = cursor
          repeat(count) {
            val p = store.getOrNull(idx)?.paragraph ?: return@repeat
            while (idx < store.size && store[idx].paragraph == p) idx++
          }
          target = idx
        } else {
          var idx = cursor
          repeat(-count) {
            val p = store.getOrNull(idx)?.paragraph ?: return@repeat
            // go to start of current paragraph, or previous one if already at start
            if (idx > 0 && store[idx - 1].paragraph == p) {
              while (idx > 0 && store[idx - 1].paragraph == p) idx--
            } else if (idx > 0) {
              val prev = store[idx - 1].paragraph
              while (idx > 0 && store[idx - 1].paragraph == prev) idx--
            }
          }
          target = idx
        }
      } else {
        target = cursor + count
      }
      cursor = target.coerceIn(0, maxOf(store.size - 1, 0))
      flushEngine()
      if (wantPlaying) refill()
    }
    currentSentence?.let { listener?.onSentence(it) }
  }

  fun seekToSentence(id: Int): Boolean {
    synchronized(lock) {
      val idx = store.indexOfFirst { it.id == id }
      if (idx < 0) return false
      cursor = idx
      flushEngine()
      if (wantPlaying) refill()
    }
    currentSentence?.let { listener?.onSentence(it) }
    return true
  }

  /** Clears the store for a new stream (seek to unreceived text) */
  fun reset(newStreamId: Int) {
    synchronized(lock) {
      flushEngine()
      store.clear()
      cursor = 0
      nextToQueue = 0
      streamId = newStreamId
      lastSeq = -1
      streamDone = false
      needMoreSentFor = -1
    }
  }

  fun updateVoice(newRate: Float? = null, newPitch: Float? = null, newVoiceId: String? = null) {
    synchronized(lock) {
      newRate?.let { rate = it }
      newPitch?.let { pitch = it }
      if (newVoiceId != null) voiceId = newVoiceId.ifEmpty { null }
      applyVoiceSettings()
      flushEngine()
      if (wantPlaying) refill()
    }
  }

  fun getVoices(forLang: String?): List<Voice> {
    val all = engine?.voices?.toList() ?: emptyList()
    if (forLang.isNullOrBlank()) return all
    val base = forLang.substringBefore('-').lowercase()
    return all.filter { it.locale.language.lowercase() == base }
  }

  fun release() {
    synchronized(lock) {
      wantPlaying = false
      playing = false
      store.clear()
      queued.clear()
      cursor = 0
      nextToQueue = 0
    }
    engine?.stop()
    engine?.shutdown()
    engine = null
    engineReady = false
  }
}
