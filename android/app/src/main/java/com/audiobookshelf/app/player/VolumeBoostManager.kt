package com.audiobookshelf.app.player

import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import com.google.android.exoplayer2.C

const val MAX_VOLUME_BOOST_DB = 12

/**
 * Amplifies the local player's output past its normal maximum volume using a LoudnessEnhancer
 * attached to the player's audio session.
 */
class VolumeBoostManager {
  private val tag = "VolumeBoostManager"

  private var loudnessEnhancer: LoudnessEnhancer? = null
  private var audioSessionId = C.AUDIO_SESSION_ID_UNSET
  private var boostDb = 0

  /** Called when the player's audio session changes so the effect can be re-attached. */
  fun setAudioSessionId(sessionId: Int) {
    if (sessionId == audioSessionId) return
    release()
    audioSessionId = sessionId
    apply()
  }

  /**
   * Sets the boost in decibels.
   * @param db Int - 0 disables the boost, max [MAX_VOLUME_BOOST_DB]
   */
  fun setBoost(db: Int) {
    val clamped = db.coerceIn(0, MAX_VOLUME_BOOST_DB)
    if (clamped == boostDb) return
    boostDb = clamped
    apply()
  }

  private fun apply() {
    if (boostDb <= 0 || audioSessionId == C.AUDIO_SESSION_ID_UNSET) {
      loudnessEnhancer?.setEnabled(false)
      return
    }

    try {
      val enhancer = loudnessEnhancer ?: LoudnessEnhancer(audioSessionId).also { loudnessEnhancer = it }
      enhancer.setTargetGain(boostDb * 100) // millibels
      enhancer.setEnabled(true)
      Log.d(tag, "Volume boost set to ${boostDb}dB on audio session $audioSessionId")
    } catch (e: Exception) {
      // Some devices do not support audio effects on every session
      Log.e(tag, "Failed to apply volume boost", e)
      release()
    }
  }

  fun release() {
    try {
      loudnessEnhancer?.release()
    } catch (e: Exception) {
      Log.e(tag, "Failed to release loudness enhancer", e)
    }
    loudnessEnhancer = null
  }
}
