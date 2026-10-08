package com.audiobookshelf.app.tts

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
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
    /** [remainingMs] 0 with running false = timer ended or cancelled */
    fun onSleepTimer(remainingMs: Long, running: Boolean, atChapterEnd: Boolean) {}
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
  /** Pause when the spoken sentence would leave this spine item (sleep timer: end of chapter) */
  @Volatile var sleepSpine: Int? = null

  private val store = ArrayList<TtsSentence>()
  private var cursor = 0          // index of the sentence currently speaking (or next to speak)
  private var nextToQueue = 0     // index of next sentence to hand to the engine
  private val queued = LinkedHashSet<Int>() // sentence ids in the engine queue
  @Volatile var playing = false
    private set
  private var wantPlaying = false
  private var engine: TextToSpeech? = null
  @Volatile private var engineReady = false
  private var needMoreSentFor = -1
  private var lastErrorAt = 0L
  private var languageWarned = false

  val currentSentence: TtsSentence? get() = synchronized(lock) { store.getOrNull(cursor) }
  val bufferedCount: Int get() = synchronized(lock) { store.size - cursor }

  // Debug builds on an emulator have no working speech engine (Google TTS crashes there), so the
  // engine is replaced by a timer that "speaks" each sentence. Everything else runs for real.
  private val useFakeEngine = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
    (android.os.Build.FINGERPRINT.contains("generic") || android.os.Build.FINGERPRINT.contains("emulator") || android.os.Build.HARDWARE.contains("ranchu"))
  private val fakeHandler = Handler(Looper.getMainLooper())
  private val fakeQueue = ArrayDeque<TtsSentence>() // main thread only
  private var fakeSpeaking = false

  private fun fakeSpeak(s: TtsSentence) {
    fakeHandler.post {
      fakeQueue.addLast(s)
      if (!fakeSpeaking) fakeNext()
    }
  }

  private fun fakeNext() {
    val s = fakeQueue.removeFirstOrNull()
    if (s == null) {
      fakeSpeaking = false
      return
    }
    fakeSpeaking = true
    progressListener.onStart(s.id.toString())
    val ms = (s.text.length * 45 / rate).toLong().coerceAtLeast(400)
    fakeHandler.postDelayed({
      progressListener.onDone(s.id.toString())
      fakeNext()
    }, ms)
  }

  private fun fakeStop() {
    fakeHandler.post {
      fakeHandler.removeCallbacksAndMessages(null)
      fakeQueue.clear()
      fakeSpeaking = false
    }
  }

  fun init() {
    if (useFakeEngine) {
      Log.w(tag, "Using fake speech engine (debug build on emulator)")
      engineReady = true
      synchronized(lock) { if (wantPlaying) refill() }
      return
    }
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
        if (!languageWarned) {
          languageWarned = true
          listener?.onError("language_unsupported", "No voice available for language $lang")
        }
      }
    }
  }

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      val id = utteranceId?.toIntOrNull() ?: return
      var sentence: TtsSentence? = null
      synchronized(lock) {
        // A callback for something that was flushed (skip, pause, seek) must not move the cursor back
        if (!queued.contains(id)) return
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
      var sleepNow = false
      synchronized(lock) {
        if (!queued.remove(id)) return // flushed/stale
        val idx = store.indexOfFirst { it.id == id }
        if (idx >= 0) cursor = minOf(idx + 1, store.size)
        val sleepAt = sleepSpine
        if (sleepAt != null && cursor < store.size && store[cursor].spine != sleepAt) {
          sleepSpine = null
          sleepNow = true
        }
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
      if (sleepNow) {
        // The next chapter starts: the cursor is already on its first sentence so resuming continues there
        pause("sleep")
        listener?.onSleepTimer(0, false, false)
        return
      }
      if (needMore) listener?.onNeedMore(streamId, lastSeq)
      if (ended) listener?.onEnded()
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      Log.e(tag, "utterance error $utteranceId")
      // Skip the sentence that failed: left in the queue it would hold its slot forever and stall the book
      onDone(utteranceId)
      val now = System.currentTimeMillis()
      if (now - lastErrorAt > 10000) {
        lastErrorAt = now
        listener?.onError("utterance_error", "Failed to speak sentence")
      }
    }
  }

  /** Must be called with lock held */
  private fun refill() {
    if (!engineReady) return
    while (queued.size < window && nextToQueue < store.size) {
      val s = store[nextToQueue++]
      queued.add(s.id)
      if (useFakeEngine) {
        fakeSpeak(s)
      } else {
        engine?.speak(s.text, TextToSpeech.QUEUE_ADD, Bundle(), s.id.toString())
      }
    }
  }

  /** Must be called with lock held */
  private fun flushEngine() {
    engine?.stop()
    if (useFakeEngine) fakeStop()
    queued.clear()
    nextToQueue = cursor
  }

  /** [startId] positions the cursor on that sentence (sentences before it are history for rewinding) */
  fun appendChunk(sid: Int, seq: Int, sentences: List<TtsSentence>, done: Boolean, startId: Int? = null) {
    var positioned: TtsSentence? = null
    synchronized(lock) {
      if (sid != streamId || seq <= lastSeq) return
      lastSeq = seq
      store.addAll(sentences)
      if (done) streamDone = true
      if (startId != null) {
        val idx = store.indexOfFirst { it.id == startId }
        if (idx >= 0) {
          cursor = idx
          flushEngine()
          // Nothing will start speaking while paused, so tell the UI where we are now
          if (!wantPlaying) positioned = store[idx]
        }
      }
      if (wantPlaying) refill()
    }
    positioned?.let { listener?.onSentence(it) }
  }

  /**
   * Text from before what was sent first, so the listener can rewind to the start of the book.
   * Goes in front of everything already here: the cursor and the engine queue shift along with it.
   */
  fun prependChunk(sid: Int, sentences: List<TtsSentence>) {
    synchronized(lock) {
      if (sid != streamId || sentences.isEmpty()) return
      store.addAll(0, sentences)
      cursor += sentences.size
      nextToQueue += sentences.size
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
      if (sleepSpine != null) {
        // The chapter it was set for may no longer be the one being read
        sleepSpine = null
        listener?.onSleepTimer(0, false, false)
      }
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
    fakeHandler.removeCallbacksAndMessages(null)
    engine = null
    engineReady = false
  }
}
