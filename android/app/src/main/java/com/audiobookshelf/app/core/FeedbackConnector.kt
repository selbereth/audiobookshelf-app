package com.audiobookshelf.app.core

import android.content.Context
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.audiobookshelf.app.R
import org.json.JSONArray
import org.json.JSONObject

/**
 * `feedback.vibrate {pattern: [ms, ...]}` and `feedback.chime {volume}` for the core's sleep timer (Phase 5). Only the
 * device calls: whether to vibrate or chime is the core's decision (the settings).
 */
class FeedbackConnector(private val context: Context) : Connector {
  private val main = Handler(Looper.getMainLooper())

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "vibrate" -> vibrate(args.getJSONArray("pattern"))
      "chime" -> main.post { chime(args.getDouble("volume").toFloat()) }
      else -> return reply(false, "unknown feedback.$method")
    }
    reply(true, "")
  }

  // SleepTimerManager.kt:250-273 (the waveform on Android 8+, a 10 ms buzz before)
  private fun vibrate(pattern: JSONArray) {
    val vibrator: Vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val timings = LongArray(pattern.length()) { pattern.getLong(it) }
      vibrator.vibrate(VibrationEffect.createWaveform(timings, -1))
    } else {
      @Suppress("DEPRECATION") vibrator.vibrate(10)
    }
  }

  // SleepTimerManager.kt:275-285
  private fun chime(volume: Float) {
    val mediaPlayer = MediaPlayer.create(context, R.raw.bell)
    mediaPlayer.setVolume(volume, volume)
    mediaPlayer.start()
    mediaPlayer.setOnCompletionListener { mediaPlayer.release() }
  }
}
