package com.audiobookshelf.app.core

import android.content.Context
import android.os.Handler
import android.support.v4.media.MediaBrowserCompat
import com.audiobookshelf.app.media.getUriToAbsIconDrawable
import com.audiobookshelf.app.media.getUriToDrawable
import android.os.Looper
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.data.Podcast
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.player.PlayerListener
import com.audiobookshelf.app.player.PlayerNotificationService
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.google.android.exoplayer2.Player
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

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

  /** Phase 7: the Pebble watch's session connection, made by the core's pebble module (only while corePebble is on) */
  private val sessionReader = jacksonObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
  private var connection: ServiceConnection? = null

  private val commands = setOf("pause", "play", "setVolume", "seekBackward", "playPause", "pauseService", "playService", "jump", "setSpeed", "seekTo", "closeOnError", "setBrowseTree")

  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    when (method) {
      "bind" -> return bind(reply)
      "release" -> return release(reply)
      "loadLocal" -> return loadLocal(args, reply)
      "loadSession" -> return loadSession(args, reply)
      "playItemPayload" -> return playItemPayload(reply)
    }
    if (method in commands) return command(method, args, reply)
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

  /**
   * Commands the core decides on (the sleep timer): pause, play, volume, seek back by ms. Run on the main thread, answered when
   * done. With no running service the answer is {live: false} and nothing happens.
   */
  private fun command(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    main.post {
      val s = service
      try {
        when (method) {
          "pause" -> s?.currentPlayer?.pause()
          "play" -> s?.currentPlayer?.play()
          "setVolume" -> s?.currentPlayer?.volume = args.getDouble("volume").toFloat()
          "seekBackward" -> s?.seekBackward(args.getLong("ms"))
          // Phase 7 (the Pebble watch): the same calls the app's own controls make, in the core's order
          "playPause" -> s?.playPause()
          "pauseService" -> s?.pause()
          "playService" -> s?.play()
          "jump" -> if (args.optBoolean("forward")) s?.jumpForward() else s?.jumpBackward()
          "setSpeed" -> s?.setPlaybackSpeed(args.getDouble("speed").toFloat())
          // Phase 9 (item 5): the core's browse tree (root, Libraries, Recent); native keeps it and builds the MediaItems from it
          "setBrowseTree" -> browseTree = args.getJSONObject("tree")
          // Phase 9 (item 4): the core decided the playback failure: the UI hears it, then the player closes (as handlePlayerPlaybackError did)
          "closeOnError" -> {
            s?.clientEventEmitter?.onPlaybackFailed(args.optString("errorMessage", "Unknown Error"))
            s?.closePlayback(true)
          }
          // Phase 9 (item 2): the core clamped the time and chose the track. Multi-track: the same calls as seekPlayer (:1000-1004)
          "seekTo" -> if (s != null && s.currentPlayer.mediaItemCount > 1 && args.has("index")) {
            s.currentPlaybackSession?.currentTime = args.getLong("ms") / 1000.0
            s.currentPlayer.seekTo(args.getInt("index"), args.getLong("offsetMs"))
          } else {
            s?.seekPlayer(args.getLong("ms"))
          }
        }
        Log.i(TAG, "player.$method (core) live=${s != null}")
        reply(true, JSONObject().put("live", s != null).toString())
      } catch (e: Exception) {
        Log.w(TAG, "player.$method failed: ${e.message}")
        reply(false, e.message ?: "failed")
      }
    }
  }

  private fun noSession() = JSONObject()
    .put("live", false).put("playing", false).put("positionSec", 0.0).put("rate", 1.0)
    .put("sessionId", JSONObject.NULL).put("session", JSONObject.NULL)
    .put("loaded", false).put("idle", false).put("lazyPlaying", false)

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
      .put("loaded", true)
      .put("idle", s.currentPlayer.playbackState == Player.STATE_IDLE)
      .put("lazyPlaying", PlayerListener.lazyIsPlaying)
    if (withSession) o.put("session", sessionJson(session) ?: JSONObject.NULL)
    return o
  }

  /** Phase 7: binds the player service (starting it) for the core's watch commands. Answers {live}; a 5 s limit. */
  private fun bind(reply: (Boolean, String) -> Unit) {
    val context = CoreHost.appContext() ?: return reply(true, JSONObject().put("live", false).toString())
    main.post {
      if (service != null) return@post reply(true, JSONObject().put("live", true).toString())
      val answered = AtomicBoolean(false)
      val answer = {
        if (answered.compareAndSet(false, true)) reply(true, JSONObject().put("live", service != null).toString())
      }
      val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
          if (service == null) service = (binder as PlayerNotificationService.LocalBinder).getService()
          main.post { answer() }
        }

        override fun onServiceDisconnected(name: ComponentName) {
          service = null
        }
      }
      connection = conn
      if (!context.bindService(Intent(context, PlayerNotificationService::class.java), conn, Context.BIND_AUTO_CREATE)) answer()
      main.postDelayed({ answer() }, 5000)
    }
  }

  /** Phase 7: the core is done with the watch: unbinds what [bind] bound */
  private fun release(reply: (Boolean, String) -> Unit) {
    main.post {
      val context = CoreHost.appContext()
      connection?.let { c -> context?.let { runCatching { it.unbindService(c) } } }
      connection = null
      reply(true, "{}")
    }
  }

  private fun okJson() = JSONObject().put("ok", true).toString()

  private fun failJson(reason: String) = JSONObject().put("ok", false).put("reason", reason).toString()

  /** Phase 7: the play-item payload the server asks for (device, codecs), built by the player as the app's screen builds it */
  private fun playItemPayload(reply: (Boolean, String) -> Unit) {
    main.post {
      val s = service ?: return@post reply(false, "no player")
      try {
        reply(true, JSONObject(sessionReader.writeValueAsString(s.getPlayItemRequestPayload(false))).toString())
      } catch (e: Exception) {
        reply(false, e.message ?: "failed")
      }
    }
  }

  /**
   * Phase 7: loads a book from the download, as AudioPrimitives.startAudio did (the tracks check, the session, the sync reset).
   * Answers {ok} or {ok: false, reason: "tracks" | "failed"}; the messages to the watch are the core's.
   */
  private fun loadLocal(args: JSONObject, reply: (Boolean, String) -> Unit) {
    CoroutineScope(Dispatchers.Default).launch {
      val s = service
      val context = CoreHost.appContext()
      if (s == null || context == null) return@launch reply(true, failJson("failed"))
      val localItem = DeviceManager.dbManager.getLocalLibraryItem(args.getString("localLibraryItemId"))
        ?: return@launch reply(true, failJson("failed"))
      val episodeId = args.optString("localEpisodeId")
      val episode = if (episodeId.isEmpty()) null else (localItem.media as? Podcast)?.episodes?.find { it.id == episodeId }
      if (!localItem.hasTracks(context, episode)) return@launch reply(true, failJson("tracks"))
      try {
        val rate = args.optDouble("playbackRate", 1.0).toFloat()
        withContext(Dispatchers.Main) {
          val session = localItem.getPlaybackSession(episode, s.getDeviceInfo())
          s.mediaProgressSyncer.reset()
          s.preparePlayer(session, true, rate)
        }
        reply(true, okJson())
      } catch (e: Exception) {
        Log.e(TAG, "loadLocal failed", e)
        reply(true, failJson("failed"))
      }
    }
  }

  /** Phase 7: loads a server session (the JSON server.playItem answered), as AudioPrimitives.startAudio did */
  private fun loadSession(args: JSONObject, reply: (Boolean, String) -> Unit) {
    CoroutineScope(Dispatchers.Default).launch {
      val s = service ?: return@launch reply(true, failJson("failed"))
      try {
        val session = sessionReader.readValue<PlaybackSession>(args.getJSONObject("session").toString())
        val rate = args.optDouble("playbackRate", 1.0).toFloat()
        withContext(Dispatchers.Main) {
          PlayerListener.lazyIsPlaying = false
          s.preparePlayer(session, true, rate)
        }
        reply(true, okJson())
      } catch (e: Exception) {
        Log.e(TAG, "loadSession failed", e)
        reply(true, failJson("failed"))
      }
    }
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
      .put("atMs", System.currentTimeMillis()) // Phase 9: the native clock at the change (the auto-rewind times, not the core's)
    CoreHost.emit("player", "state", data)
  }

  /** Phase 9 (item 4): a playback error the core decides on (the direct play fallback). The payload is the one the app asks with, forceTranscode */
  fun emitPlaybackError(s: PlayerNotificationService, errorMessage: String) {
    val session = s.currentPlaybackSession ?: return
    val data = JSONObject()
      .put("playMethod", session.playMethod)
      .put("errorMessage", errorMessage)
      .put("libraryItemId", session.libraryItemId ?: JSONObject.NULL)
      .put("episodeId", session.episodeId ?: JSONObject.NULL)
      .put("payload", JSONObject(mapper.writeValueAsString(s.getPlayItemRequestPayload(true))))
      .put("playbackRate", s.currentPlayer.playbackParameters.speed.toDouble())
    CoreHost.emit("player", "playbackError", data)
  }

  /** Phase 9 (item 5): the browse tree from the core, or null (a miss: the old Kotlin tree answers). Only the root and the two lists */
  @Volatile
  var browseTree: JSONObject? = null

  /** Native facts for the core's browse tree: items in progress, the libraries and whether the recents were loaded */
  fun emitBrowseInputs(inProgressCount: Int, libraries: List<com.audiobookshelf.app.data.Library>, recentsLoaded: Boolean) {
    val libs = org.json.JSONArray()
    libraries.forEach { lib ->
      libs.put(JSONObject().put("id", lib.id).put("name", lib.name).put("icon", lib.icon).put("stats", lib.stats?.let { JSONObject().put("numAudioFiles", it.numAudioFiles) } ?: JSONObject.NULL))
    }
    CoreHost.emit("player", "browseInputs", JSONObject().put("inProgressCount", inProgressCount).put("libraries", libs).put("recentsLoaded", recentsLoaded))
  }

  /** The MediaItems the core's tree gives for a parent, or null when the tree does not cover that parent (old tree answers) */
  fun browseChildren(parentId: String, context: Context): MutableList<MediaBrowserCompat.MediaItem>? {
    val tree = browseTree ?: return null
    val list = when (parentId) {
      "/" -> tree.optJSONArray("root")
      "__LIBRARIES__", "__RECENTLY__" -> tree.optJSONObject("children")?.optJSONArray(parentId)
      else -> null
    } ?: return null
    val out = mutableListOf<MediaBrowserCompat.MediaItem>()
    for (i in 0 until list.length()) {
      val o = list.getJSONObject(i)
      val icon = o.optString("icon")
      val art = when (icon) {
        "continue" -> getUriToDrawable(context, com.audiobookshelf.app.R.drawable.exo_icon_localaudio)
        "recent" -> getUriToDrawable(context, com.audiobookshelf.app.R.drawable.md_clock_outline)
        "downloads" -> getUriToDrawable(context, com.audiobookshelf.app.R.drawable.exo_icon_downloaddone)
        "libraries" -> getUriToDrawable(context, com.audiobookshelf.app.R.drawable.icon_library_folder)
        else -> getUriToAbsIconDrawable(context, icon)
      }
      val desc = android.support.v4.media.MediaDescriptionCompat.Builder()
        .setMediaId(o.getString("id")).setTitle(o.getString("title")).setIconUri(art).build()
      out += MediaBrowserCompat.MediaItem(desc, MediaBrowserCompat.MediaItem.FLAG_BROWSABLE)
    }
    return out
  }

  fun emitSessionOpened(session: PlaybackSession) {
    val json = sessionJson(session) ?: return
    CoreHost.emit("session", "opened", JSONObject().put("session", json))
  }
}
