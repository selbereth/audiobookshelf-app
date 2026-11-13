package com.audiobookshelf.app.pebble

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import com.audiobookshelf.app.data.LocalLibraryItem
import com.audiobookshelf.app.data.LocalMediaProgress
import com.audiobookshelf.app.data.MediaProgress
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.data.Podcast
import com.audiobookshelf.app.data.PodcastEpisode
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaEventManager
import com.audiobookshelf.app.player.PlayerListener
import com.audiobookshelf.app.player.PlayerNotificationService
import com.audiobookshelf.app.plugins.AbsLogger
import com.audiobookshelf.app.server.ApiHandler
import com.google.android.exoplayer2.Player
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * What the shared Pebble logic (`utils/pebble/hub.js`) asks of the audiobook player: small steps, no decisions. It uses the same
 * [PlayerNotificationService] as the app, whether or not the app's screen is open.
 */
class AudioPrimitives(private val context: Context) {
  private val tag = "AudioPrimitives"
  private var player: PlayerNotificationService? = null
  private var connection: ServiceConnection? = null

  /** Binds to the player service (starting it if it is not running). Null if it did not come up in time. */
  private suspend fun player(): PlayerNotificationService? {
    player?.let { return it }
    return withTimeoutOrNull(5000) {
      suspendCancellableCoroutine { cont ->
        val conn = object : ServiceConnection {
          override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val bound = (service as PlayerNotificationService.LocalBinder).getService()
            player = bound
            if (cont.isActive) cont.resume(bound)
          }

          override fun onServiceDisconnected(name: ComponentName) {
            player = null
          }
        }
        connection = conn
        val bound = context.bindService(Intent(context, PlayerNotificationService::class.java), conn, Context.BIND_AUTO_CREATE)
        if (!bound && cont.isActive) cont.resume(null)
        cont.invokeOnCancellation { runCatching { context.unbindService(conn) } }
      }
    }
  }

  fun release() {
    connection?.let { runCatching { context.unbindService(it) } }
    connection = null
    player = null
  }

  /** The player has a book loaded (the service can be running without one) */
  private fun PlayerNotificationService.hasBook() = currentPlaybackSession != null

  private fun speed(): Float {
    player?.let { return it.mediaManager.getSavedPlaybackRate() }
    val prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
    return runCatching { JSONObject(prefs.getString("userSettings", null) ?: "").getDouble("playbackRate").toFloat() }.getOrDefault(1f)
  }

  private fun sessionJson(session: PlaybackSession): JSONObject {
    val chapters = JSONArray()
    session.chapters.forEach { chapters.put(JSONObject().put("title", it.title).put("start", it.start).put("end", it.end)) }
    return JSONObject().put("title", session.displayTitle ?: "").put("duration", session.duration).put("chapters", chapters)
  }

  /** What is loaded (or was played last), where it is and whether it plays. Binds only when the player is already running. */
  suspend fun state(): JSONObject {
    val live = PlayerNotificationService.isStarted
    val service = if (live) player() else null
    val out = JSONObject().put("live", live).put("speed", speed().toString().toDouble())
      .put("lastUpdatedAt", DeviceManager.deviceData.lastPlaybackSession?.updatedAt ?: 0L)
    val current = service?.currentPlaybackSession
    if (service != null && current != null) {
      return out.put("playing", PlayerListener.lazyIsPlaying)
        .put("time", withContext(Dispatchers.Main) { service.getCurrentTimeSeconds() }).put("session", sessionJson(current))
    }
    val last = DeviceManager.deviceData.lastPlaybackSession
    return out.put("playing", false).put("time", last?.currentTime ?: 0.0).put("session", last?.let { sessionJson(it) } ?: JSONObject.NULL)
  }

  suspend fun pause() {
    if (!PlayerNotificationService.isStarted) return
    player()?.let { withContext(Dispatchers.Main) { it.pause() } }
  }

  /** Toggles; a book whose loading failed, or none loaded, loads the book played last */
  suspend fun playPause(): JSONObject {
    val service = player() ?: return error("Open Audiobookshelf on the phone")
    // A book whose loading failed (the server did not answer) stays "loaded" but the player is idle and play does nothing:
    // load it again instead
    val failed = withContext(Dispatchers.Main) { service.hasBook() && service.currentPlayer.playbackState == Player.STATE_IDLE }
    if (service.hasBook() && !failed) {
      withContext(Dispatchers.Main) { service.playPause() }
      return JSONObject()
    }
    val last = DeviceManager.deviceData.lastPlaybackSession ?: return error("Play a book in Selbershelf on the phone first")
    val localItem = last.localLibraryItem?.id?.let { DeviceManager.dbManager.getLocalLibraryItem(it) }
    return startAudio(service, last.displayTitle ?: "", localItem, last.localEpisodeId, last.libraryItemId, last.episodeId, last.serverConnectionConfigId)
  }

  suspend fun jump(forward: Boolean) {
    val service = player()
    if (service == null || !service.hasBook()) return // nothing is loaded: skipping has no meaning
    withContext(Dispatchers.Main) { if (forward) service.jumpForward() else service.jumpBackward() }
  }

  /** The one place the speed changes is [PlayerNotificationService.setPlaybackSpeed]: it saves it and tells the app's screen */
  suspend fun setSpeed(speed: Float) {
    val service = player() ?: return
    withContext(Dispatchers.Main) { service.setPlaybackSpeed(speed) }
  }

  suspend fun start(libraryItemId: String?, localLibraryItemId: String?): JSONObject {
    val service = player() ?: return error("Open Audiobookshelf on the phone")
    val localItem = localLibraryItemId?.let { DeviceManager.dbManager.getLocalLibraryItem(it) }
    return startAudio(service, "", localItem, null, libraryItemId, null, null)
  }

  /**
   * Loads a book into the player and starts it: from the download when there is [localItem], otherwise from the server.
   * The app's screen does the same when you press play on a book.
   */
  private suspend fun startAudio(
    service: PlayerNotificationService,
    title: String,
    localItem: LocalLibraryItem?,
    localEpisodeId: String?,
    libraryItemId: String?,
    episodeId: String?,
    serverConnectionConfigId: String?
  ): JSONObject {
    // The playback speed saved in the app's settings: without it the book would start at normal speed (the app passes it from its screen)
    val playbackRate = service.mediaManager.getSavedPlaybackRate()
    return try {
      if (localItem != null) {
        var episode: PodcastEpisode? = null
        if (!localEpisodeId.isNullOrEmpty()) {
          episode = (localItem.media as? Podcast)?.episodes?.find { it.id == localEpisodeId }
        }
        if (!localItem.hasTracks(context, episode)) return error("Audio files are missing: download the book again")
        useNewerServerProgress(localItem, episode)
        withContext(Dispatchers.Main) {
          val session = localItem.getPlaybackSession(episode, service.getDeviceInfo())
          service.mediaProgressSyncer.reset()
          service.preparePlayer(session, true, playbackRate)
        }
      } else {
        val serverItemId = libraryItemId ?: return error("Open Audiobookshelf on the phone")
        // The app's screen sets the server connection when it starts; started from the watch there is no screen, so
        // use the one the book was played from (or the last one used). Without it the request has no address.
        if (DeviceManager.serverConnectionConfig == null) {
          DeviceManager.serverConnectionConfig = DeviceManager.getServerConnectionConfig(serverConnectionConfigId)
            ?: DeviceManager.getServerConnectionConfig(DeviceManager.deviceData.lastServerConnectionConfigId)
        }
        if (DeviceManager.serverConnectionConfig == null) return error("Log in to the server in the app first")
        val payload = service.getPlayItemRequestPayload(false)
        val session = suspendCancellableCoroutine<PlaybackSession?> { cont ->
          ApiHandler(context).playLibraryItem(serverItemId, episodeId, payload) { if (cont.isActive) cont.resume(it) }
        } ?: return error("Could not reach the server")
        withContext(Dispatchers.Main) {
          PlayerListener.lazyIsPlaying = false
          service.preparePlayer(session, true, playbackRate)
        }
      }
      JSONObject().put("loading", true).put("title", title)
    } catch (e: Exception) {
      // Android can refuse to start the playback service while the app is in the background
      Log.e(tag, "Failed to start the book", e)
      error("Open Audiobookshelf on the phone")
    }
  }

  /**
   * After a book has been started: wait until it is really playing. Android 16 ignores an audio focus request from an
   * app that is still in the background, so a book started from the watch can be loaded but silent. Once the player
   * service is in the foreground, asking it to play again works, so that is tried a couple of times.
   */
  suspend fun awaitPlaying(): JSONObject {
    var nudges = 0
    repeat(WAIT_SECONDS) { second ->
      delay(1000)
      val service = if (PlayerNotificationService.isStarted) player() else null
      if (service != null && service.hasBook()) {
        if (PlayerListener.lazyIsPlaying) return JSONObject().put("playing", true)
        if (second >= 2 && second % 3 == 2 && nudges < 3) {
          nudges++
          Log.d(tag, "Book is loaded but not playing, asking it to play (attempt $nudges)")
          withContext(Dispatchers.Main) { service.play() }
        }
      }
    }
    Log.w(tag, "The book did not start playing")
    return JSONObject().put("playing", false)
  }

  private fun error(message: String) = JSONObject().put("error", message)

  /**
   * Before a downloaded book starts: the server's progress for it is written to the local progress when it is newer (a newer
   * lastUpdate wins, as in the core's startup sync), so the session built from the local progress starts there. It never blocks
   * or fails the start: when the server cannot be asked, the local progress is used as it is.
   */
  private suspend fun useNewerServerProgress(localItem: LocalLibraryItem, episode: PodcastEpisode?) {
    fun couldNot(why: String) = AbsLogger.info(tag, "Pebble start: could not check the server ($why), using local progress")
    try {
      val libraryItemId = localItem.libraryItemId
      if (libraryItemId.isNullOrEmpty()) return couldNot("not linked to a server")
      val config = DeviceManager.getServerConnectionConfig(localItem.serverConnectionConfigId) ?: return couldNot("not logged in to its server")
      if (!DeviceManager.checkConnectivity(context)) return couldNot("offline")
      val episodeId = episode?.serverEpisodeId
      val mediaProgressId = if (episode == null) localItem.id else "${localItem.id}-${episode.id}"
      val local = DeviceManager.dbManager.getLocalMediaProgress(mediaProgressId)
      val server = withTimeoutOrNull(SERVER_CHECK_TIMEOUT_MS) {
        suspendCancellableCoroutine<MediaProgress?> { cont ->
          ApiHandler(context).getMediaProgress(libraryItemId, episodeId, config) { if (cont.isActive) cont.resume(it) }
        }
      } ?: return couldNot("no answer in time or an error")
      val localUpdate = local?.lastUpdate ?: 0L
      if (server.lastUpdate <= localUpdate) return AbsLogger.info(tag, "Pebble start: local progress is current")
      AbsLogger.info(tag, "Pebble start: server progress is newer (${server.lastUpdate} vs $localUpdate), using it")
      // The startup sync's write: the server progress is applied to the local row (created when there is none)
      val progress = local ?: LocalMediaProgress(
        id = mediaProgressId, localLibraryItemId = localItem.id, localEpisodeId = episode?.id, duration = server.duration, progress = 0.0,
        currentTime = 0.0, isFinished = false, ebookLocation = null, ebookProgress = null, lastUpdate = 0L, startedAt = 0L, finishedAt = null,
        serverConnectionConfigId = localItem.serverConnectionConfigId, serverAddress = localItem.serverAddress, serverUserId = localItem.serverUserId,
        libraryItemId = libraryItemId, episodeId = episodeId
      )
      progress.currentTime = server.currentTime
      progress.progress = server.progress
      progress.isFinished = server.isFinished
      progress.duration = server.duration
      progress.ebookLocation = server.ebookLocation
      progress.ebookProgress = server.ebookProgress
      progress.lastUpdate = server.lastUpdate
      progress.startedAt = server.startedAt
      progress.finishedAt = server.finishedAt
      MediaEventManager.syncEvent(server, "Sync on server connection")
      DeviceManager.dbManager.saveLocalMediaProgress(progress)
    } catch (e: Exception) {
      couldNot(e.message ?: "failed")
    }
  }

  private companion object {
    const val WAIT_SECONDS = 20
    const val SERVER_CHECK_TIMEOUT_MS = 4000L
  }
}
