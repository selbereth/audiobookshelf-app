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
import com.audiobookshelf.app.tts.TtsHeadless
import com.audiobookshelf.app.tts.TtsService
import com.audiobookshelf.app.tts.TtsSnapshot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import com.google.android.exoplayer2.Player
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
  val durationSeconds: Int = 0,
  val volume: Int = 0, // the media volume step, so the watch can tell when a volume press really changed it
  val kind: Int = PebbleProtocol.KIND_AUDIO
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

  /**
   * The EPUB read-aloud session when that is what the watch controls: it is reading now, or (when nothing plays) it was
   * used after the audiobook was. Null when the watch controls the audiobook player.
   */
  private fun currentTts(): TtsSnapshot? {
    val snapshot = TtsSnapshot.load(context) ?: return null
    if (TtsService.instance?.controller?.playing == true) return snapshot
    if (PlayerNotificationService.isStarted && PlayerListener.lazyIsPlaying) return null
    val audioAt = DeviceManager.deviceData.lastPlaybackSession?.updatedAt ?: 0L
    return if (snapshot.updatedAt > audioAt) snapshot else null
  }

  private fun ttsStatus(snapshot: TtsSnapshot, state: Int? = null): PebbleStatus {
    val reading = TtsService.instance?.controller?.playing == true
    return PebbleStatus(
      state = state ?: if (reading) PebbleProtocol.STATE_PLAYING else PebbleProtocol.STATE_PAUSED,
      title = title(snapshot.title),
      chapter = title(snapshot.chapter),
      chapterNumber = snapshot.chapterNumber,
      chapterCount = snapshot.chapterCount,
      // The percentage in hundredths of a percent: the watch shows it as "42%" and draws the bar from it
      positionSeconds = (snapshot.progress.coerceIn(0.0, 100.0) * 100).toInt(),
      durationSeconds = 10000,
      volume = volumeStep(),
      kind = PebbleProtocol.KIND_EPUB
    )
  }

  /** Play or pause the read-aloud. When it is not running (the app was closed) the app is opened to carry on where it was. */
  private suspend fun ttsPlayPause(snapshot: TtsSnapshot): PebbleStatus {
    val service = TtsService.instance
    if (service != null) {
      withContext(Dispatchers.Main) { if (service.controller.playing) service.controller.pause() else service.startPlayback() }
      return ttsStatus(snapshot)
    }
    if (snapshot.session.isEmpty()) return error("Read aloud once in the app first")
    return try {
      // The reading is done by the web part (it opens the book and cuts the text into sentences): it runs in a hidden
      // page, the app's screen stays closed. Only one thing owns playback: the audiobook player is paused first.
      if (PlayerNotificationService.isStarted) {
        player()?.let { withContext(Dispatchers.Main) { it.pause() } }
      }
      TtsHeadless.resume(context, snapshot.session)
      ttsStatus(snapshot, PebbleProtocol.STATE_LOADING)
    } catch (e: Exception) {
      Log.e(tag, "Failed to start reading aloud", e)
      error("Could not start reading aloud")
    }
  }

  private suspend fun ttsSkip(forward: Boolean, snapshot: TtsSnapshot): PebbleStatus {
    val service = TtsService.instance ?: return ttsStatus(snapshot) // not running: skipping has no meaning
    withContext(Dispatchers.Main) { service.controller.skip("paragraph", if (forward) 1 else -1) }
    return ttsStatus(snapshot)
  }

  /** What is playing, or what would start. Binds only when the player is already running. */
  suspend fun status(): PebbleStatus {
    currentTts()?.let { return ttsStatus(it) }
    val service = if (PlayerNotificationService.isStarted) player() else null
    service?.currentPlaybackSession?.let {
      val state = if (service.isPlayingNow()) PebbleProtocol.STATE_PLAYING else PebbleProtocol.STATE_PAUSED
      return describe(state, it, withContext(Dispatchers.Main) { service.getCurrentTimeSeconds() })
    }
    val last = DeviceManager.deviceData.lastPlaybackSession ?: return PebbleStatus(PebbleProtocol.STATE_NOTHING_TO_PLAY, "", volume = volumeStep())
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
      durationSeconds = session.duration.coerceAtLeast(0.0).toInt(),
      volume = volumeStep()
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
    val waitSeconds = if (currentTts() != null) TTS_WAIT_SECONDS else WAIT_SECONDS
    repeat(waitSeconds) { second ->
      delay(1000)
      // Read-aloud from the watch: the app has to start and open the book first, so it can take a while
      if (TtsService.instance?.controller?.playing == true) return status()
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
    // Still not playing: say so instead of showing "Paused", as if nothing had been asked
    Log.w(tag, "The book did not start playing")
    return error("Could not start playback. Check the phone's connection and try again")
  }

  private suspend fun playPause(): PebbleStatus {
    currentTts()?.let { return ttsPlayPause(it) }
    val service = player() ?: return error("Open Audiobookshelf on the phone")
    // A book whose loading failed (the server did not answer) stays "loaded" but the player is idle and play does nothing:
    // load it again instead
    val failed = withContext(Dispatchers.Main) { service.hasBook() && service.currentPlayer.playbackState == Player.STATE_IDLE }
    if (service.hasBook() && !failed) {
      withContext(Dispatchers.Main) { service.playPause() }
      return status()
    }
    return startMostRecent(service)
  }

  private fun volumeStep(): Int {
    val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return audio.getStreamVolume(AudioManager.STREAM_MUSIC)
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
    currentTts()?.let { return ttsSkip(forward, it) }
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
    const val TTS_WAIT_SECONDS = 45
  }

  private fun error(message: String) = PebbleStatus(PebbleProtocol.STATE_ERROR, message)

  private fun title(title: String?): String = (title ?: "").take(PebbleProtocol.MAX_TITLE_LENGTH)
}
