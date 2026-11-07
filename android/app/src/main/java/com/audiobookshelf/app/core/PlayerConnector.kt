package com.audiobookshelf.app.core

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.player.PlayerNotificationService
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.json.JSONObject

/**
 * `player.getPosition` and `player.getState`, answered from the running player on the main thread (ExoPlayer is main-thread only).
 * With no player or no session they answer `{live: false, ...}`, never an error. `getState` also carries the session JSON.
 * Events up (the facts at the moment they happened; the core decides what they mean):
 *  - `player state {reason, sessionId, playing, positionSec, rate, error}` with reason playing, paused, seeked, ended, rate, closed.
 *    Only where the player is really playing or paused (the buffering and lazy-play filters stay in PlayerListener).
 *  - `session opened {session}` when a playback session is prepared.
 */
object PlayerConnector : Connector {
  private const val TAG = "PlayerConnector"
  private val main = Handler(Looper.getMainLooper())
  private val mapper = jacksonObjectMapper()

  /** The running service, set by PlayerNotificationService in onCreate and cleared in onDestroy */
  @Volatile
  var service: PlayerNotificationService? = null

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    if (method != "getPosition" && method != "getState") return reply(false, "unknown player.$method")
    main.post {
      val json = try {
        snapshot(method == "getState")
      } catch (e: Exception) {
        Log.w(TAG, "player.$method: ${e.message}")
        noSession()
      }
      reply(true, json.toString())
    }
  }

  private fun noSession() = JSONObject()
    .put("live", false).put("playing", false).put("positionSec", 0.0).put("rate", 1.0)
    .put("sessionId", JSONObject.NULL).put("session", JSONObject.NULL)

  private fun snapshot(withSession: Boolean): JSONObject {
    val s = service ?: return noSession()
    val session = s.currentPlaybackSession ?: return noSession()
    val o = JSONObject()
      .put("live", true)
      .put("playing", s.currentPlayer.isPlaying)
      .put("positionSec", s.getCurrentTimeSeconds())
      .put("rate", s.currentPlayer.playbackParameters.speed.toDouble())
      .put("sessionId", session.id)
      .put("atMs", System.currentTimeMillis())
    if (withSession) o.put("session", sessionJson(session) ?: JSONObject.NULL)
    return o
  }

  private fun sessionJson(session: PlaybackSession): JSONObject? = try {
    JSONObject(mapper.writeValueAsString(session))
  } catch (e: Exception) {
    Log.w(TAG, "session JSON failed: ${e.message}")
    null
  }

  /** Native fact at the moment of a change. Called on the main thread by the player's listeners and the service. */
  fun emitState(reason: String, s: PlayerNotificationService, error: Boolean = false) {
    val data = JSONObject()
      .put("reason", reason)
      .put("sessionId", s.currentPlaybackSession?.id ?: JSONObject.NULL)
      .put("playing", s.currentPlayer.isPlaying)
      .put("positionSec", s.getCurrentTimeSeconds())
      .put("rate", s.currentPlayer.playbackParameters.speed.toDouble())
      .put("error", error)
    CoreHost.emit("player", "state", data)
  }

  fun emitSessionOpened(session: PlaybackSession) {
    val json = sessionJson(session) ?: return
    CoreHost.emit("session", "opened", JSONObject().put("session", json))
  }
}
