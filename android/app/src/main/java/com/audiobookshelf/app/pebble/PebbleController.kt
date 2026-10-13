package com.audiobookshelf.app.pebble

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.media.AudioManager
import android.os.IBinder
import android.util.Log
import com.audiobookshelf.app.data.PlaybackSession
import com.audiobookshelf.app.data.Podcast
import com.audiobookshelf.app.data.PodcastEpisode
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.player.PlayerListener
import com.audiobookshelf.app.player.PlayerNotificationService
import com.audiobookshelf.app.server.ApiHandler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/** What the watch is shown. The chapter and position are for a book that is loaded or was played last. */
data class PebbleStatus(
  val state: Int,
  val title: String,
  val chapter: String = "",
  val chapterNumber: Int = 0,
  val chapterCount: Int = 0,
  val positionSeconds: Int = 0,
  val durationSeconds: Int = 0
)

/**
 * Does what the watch asks of the audiobook player: play or pause, skip, and start the book played most recently.
 * It uses the same [PlayerNotificationService] as the app, whether or not the app's screen is open.
 */
class PebbleController(private val context: Context) {
  private val tag = "PebbleController"
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

  private fun PlayerNotificationService.isPlayingNow() = hasBook() && PlayerListener.lazyIsPlaying

  /** What is playing, or what would start. Binds only when the player is already running. */
  suspend fun status(): PebbleStatus {
    val service = if (PlayerNotificationService.isStarted) player() else null
    service?.currentPlaybackSession?.let {
      val state = if (service.isPlayingNow()) PebbleProtocol.STATE_PLAYING else PebbleProtocol.STATE_PAUSED
      return describe(state, it, withContext(Dispatchers.Main) { service.getCurrentTimeSeconds() })
    }
    val last = DeviceManager.deviceData.lastPlaybackSession ?: return PebbleStatus(PebbleProtocol.STATE_NOTHING_TO_PLAY, "")
    return describe(PebbleProtocol.STATE_PAUSED, last, last.currentTime)
  }

  /** The book, the chapter at [time] and how far into the book that is */
  private fun describe(state: Int, session: PlaybackSession, time: Double): PebbleStatus {
    val chapters = session.chapters
    val index = chapters.indexOfFirst { time >= it.start && time < it.end }
    return PebbleStatus(
      state = state,
      title = title(session.displayTitle),
      chapter = if (index >= 0) title(chapters[index].title) else "",
      chapterNumber = if (index >= 0) index + 1 else 0,
      chapterCount = chapters.size,
      positionSeconds = time.coerceAtLeast(0.0).toInt(),
      durationSeconds = session.duration.coerceAtLeast(0.0).toInt()
    )
  }

  suspend fun handle(command: Int): PebbleStatus {
    return when (command) {
      PebbleProtocol.CMD_PLAY_PAUSE -> playPause()
      PebbleProtocol.CMD_SKIP_FORWARD -> skip(forward = true)
      PebbleProtocol.CMD_SKIP_BACK -> skip(forward = false)
      PebbleProtocol.CMD_VOLUME_UP -> changeVolume(AudioManager.ADJUST_RAISE)
      PebbleProtocol.CMD_VOLUME_DOWN -> changeVolume(AudioManager.ADJUST_LOWER)
      else -> status()
    }
  }

  /**
   * After a book has been started: wait until it is really playing. Android 16 ignores an audio focus request from an
   * app that is still in the background, so a book started from the watch can be loaded but silent. Once the player
   * service is in the foreground, asking it to play again works, so that is tried a couple of times.
   */
  suspend fun waitUntilPlaying(): PebbleStatus {
    var nudges = 0
    repeat(WAIT_SECONDS) { second ->
      delay(1000)
      val service = if (PlayerNotificationService.isStarted) player() else null
      if (service != null && service.hasBook()) {
        if (service.isPlayingNow()) return status()
        if (second >= 2 && second % 3 == 2 && nudges < 3) {
          nudges++
          Log.d(tag, "Book is loaded but not playing, asking it to play (attempt $nudges)")
          withContext(Dispatchers.Main) { service.play() }
        }
      }
    }
    return status()
  }

  private suspend fun playPause(): PebbleStatus {
    val service = player() ?: return error("Open Audiobookshelf on the phone")
    if (service.hasBook()) {
      withContext(Dispatchers.Main) { service.playPause() }
      return status()
    }
    return startMostRecent(service)
  }

  /** One step of the media volume, the one the book plays on. The phone shows its own volume slider. */
  private suspend fun changeVolume(direction: Int): PebbleStatus {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    try {
      audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
    } catch (e: SecurityException) {
      Log.w(tag, "Could not change the volume", e)
    }
    return status()
  }

  private suspend fun skip(forward: Boolean): PebbleStatus {
    val service = player()
    if (service == null || !service.hasBook()) return status() // nothing is loaded: skipping has no meaning
    withContext(Dispatchers.Main) { if (forward) service.jumpForward() else service.jumpBackward() }
    return status()
  }

  /** Starts the book that was played last, from where it was left, the way the app does when you press play on it */
  private suspend fun startMostRecent(service: PlayerNotificationService): PebbleStatus {
    val last = DeviceManager.deviceData.lastPlaybackSession ?: return PebbleStatus(PebbleProtocol.STATE_NOTHING_TO_PLAY, "")
    val title = title(last.displayTitle)
    // The playback speed saved in the app's settings: without it the book would start at normal speed (the app passes it from its screen)
    val playbackRate = service.mediaManager.getSavedPlaybackRate()
    return try {
      val localItem = last.localLibraryItem?.id?.let { DeviceManager.dbManager.getLocalLibraryItem(it) }
      if (localItem != null) {
        var episode: PodcastEpisode? = null
        if (!last.localEpisodeId.isNullOrEmpty()) {
          episode = (localItem.media as? Podcast)?.episodes?.find { it.id == last.localEpisodeId }
        }
        if (!localItem.hasTracks(context, episode)) return error("Audio files are missing: download the book again")
        withContext(Dispatchers.Main) {
          val session = localItem.getPlaybackSession(episode, service.getDeviceInfo())
          service.mediaProgressSyncer.reset()
          service.preparePlayer(session, true, playbackRate)
        }
      } else {
        val libraryItemId = last.libraryItemId ?: return error("Open Audiobookshelf on the phone")
        // The app's screen sets the server connection when it starts; started from the watch there is no screen, so
        // use the one the book was played from (or the last one used). Without it the request has no address.
        if (DeviceManager.serverConnectionConfig == null) {
          DeviceManager.serverConnectionConfig = DeviceManager.getServerConnectionConfig(last.serverConnectionConfigId)
            ?: DeviceManager.getServerConnectionConfig(DeviceManager.deviceData.lastServerConnectionConfigId)
        }
        if (DeviceManager.serverConnectionConfig == null) return error("Log in to the server in the app first")
        val payload = service.getPlayItemRequestPayload(false)
        val session = suspendCancellableCoroutine<PlaybackSession?> { cont ->
          ApiHandler(context).playLibraryItem(libraryItemId, last.episodeId, payload) { if (cont.isActive) cont.resume(it) }
        } ?: return error("Could not reach the server")
        withContext(Dispatchers.Main) {
          PlayerListener.lazyIsPlaying = false
          service.preparePlayer(session, true, playbackRate)
        }
      }
      status().copy(state = PebbleProtocol.STATE_LOADING, title = title)
    } catch (e: Exception) {
      // Android can refuse to start the playback service while the app is in the background
      Log.e(tag, "Failed to start the most recent book", e)
      error("Open Audiobookshelf on the phone")
    }
  }

  private companion object {
    const val WAIT_SECONDS = 20
  }

  private fun error(message: String) = PebbleStatus(PebbleProtocol.STATE_ERROR, message)

  private fun title(title: String?): String = (title ?: "").take(PebbleProtocol.MAX_TITLE_LENGTH)
}
