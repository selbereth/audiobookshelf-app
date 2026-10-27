package com.audiobookshelf.app.tts

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log

/**
 * Plays silence while read aloud is speaking.
 *
 * The speech comes from the speech engine, which is another app: this app itself plays no audio. Android only gives the media
 * buttons (a Bluetooth headset's play and pause) to a media session whose own app is playing audio, so while read aloud ran from the
 * hidden page (started from the watch, no screen) the buttons went to whatever app held them last. A silent stream under this
 * app's name makes the read-aloud session the one that gets them.
 */
class SilentAudio {
  private var track: AudioTrack? = null
  private var thread: Thread? = null
  @Volatile private var running = false

  val isRunning get() = running

  fun start() {
    if (running) return
    try {
      val rate = 8000
      val minBuffer = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
      val audioTrack = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setBufferSizeInBytes(minBuffer.coerceAtLeast(rate / 2))
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
      track = audioTrack
      running = true
      audioTrack.play()
      thread = Thread {
        val silence = ByteArray(rate / 5) // 100 ms of zeros (16 bit mono)
        while (running) {
          if (audioTrack.write(silence, 0, silence.size) < 0) break
        }
      }.apply {
        name = "abs-tts-silence"
        isDaemon = true
        start()
      }
    } catch (e: Exception) {
      Log.w("SilentAudio", "Could not start the silent stream", e)
      stop()
    }
  }

  fun stop() {
    running = false
    val audioTrack = track
    track = null
    thread = null
    if (audioTrack != null) {
      try {
        audioTrack.pause()
        audioTrack.flush()
        audioTrack.release()
      } catch (e: Exception) {
        Log.w("SilentAudio", "Could not stop the silent stream", e)
      }
    }
  }
}
