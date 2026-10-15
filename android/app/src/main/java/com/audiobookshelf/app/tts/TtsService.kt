package com.audiobookshelf.app.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import androidx.core.content.FileProvider
import com.audiobookshelf.app.BuildConfig
import com.audiobookshelf.app.player.resolveUriAsBitmap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.R

/**
 * Foreground service hosting the TTS media session, notification, audio focus and wake lock.
 * The [TtsController] it drives is owned by the service so speech continues with the screen off.
 */
class TtsService : Service() {
  companion object {
    const val CHANNEL_ID = "abs_tts_channel"
    const val NOTIFICATION_ID = 7421
    const val ACTION_START = "com.audiobookshelf.app.tts.START"
    const val ACTION_STOP = "com.audiobookshelf.app.tts.STOP"
    /** A button in the notification: the key code to act on is in [EXTRA_KEY_CODE] */
    const val ACTION_KEY = "com.audiobookshelf.app.tts.KEY"
    const val EXTRA_KEY_CODE = "keyCode"
    const val EXTRA_TITLE = "title"
    const val EXTRA_AUTHOR = "author"
    const val EXTRA_COVER_URI = "coverUri"
    /** The card Android draws for the media session shows these where the audiobook player shows its jump back and forward */
    const val CUSTOM_REWIND = "tts_rewind"
    const val CUSTOM_FORWARD = "tts_forward"

    @Volatile var instance: TtsService? = null

    /**
     * Stops the service. `instance` is cleared at once so nothing (a new session, the audiobook hand-off)
     * can pick up a service that is shutting down, and the JS side is told here rather than from onDestroy.
     */
    fun requestStop(reason: String = "stopped") {
      val service = instance ?: return
      instance = null
      eventListener?.onState(false, reason)
      service.stopSelf()
    }
    /** Set by the plugin so events reach JS; reapplied when the service is created */
    @Volatile var eventListener: TtsController.Listener? = null
  }

  lateinit var controller: TtsController
  private lateinit var session: MediaSessionCompat
  private lateinit var audioManager: AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var wakeLock: PowerManager.WakeLock? = null
  /** Keeps this app 'playing audio' while the speech engine (another app) speaks, so the media buttons come to this session */
  private val silentAudio = SilentAudio()
  private var title = ""
  private var author = ""
  /** The cover, as in the audiobook notification: it is what gives the notification its colours */
  private var cover: Bitmap? = null
  private var coverJob: Job? = null
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private var noisyRegistered = false

  private val noisyReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      controller.pause("noisy")
    }
  }

  /** Paused by a temporary focus loss (a call, a navigation prompt): resume when it is given back */
  private var resumeOnFocusGain = false

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        resumeOnFocusGain = false
        if (controller.playing) controller.pause("focus")
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        if (controller.playing) {
          resumeOnFocusGain = true
          controller.pause("focus")
        }
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        if (resumeOnFocusGain) {
          resumeOnFocusGain = false
          controller.play()
        }
      }
    }
  }

  private val forwardingListener = object : TtsController.Listener {
    override fun onSentence(s: TtsSentence) {
      // The notification does not show the sentence: rebuilding it for every one would be wasted work
      eventListener?.onSentence(s)
    }
    override fun onState(playing: Boolean, reason: String?) {
      mainHandler.post {
        if (playing) acquireResources() else releaseResources()
        updateSession()
      }
      eventListener?.onState(playing, reason)
    }
    override fun onNeedMore(streamId: Int, lastSeq: Int) { eventListener?.onNeedMore(streamId, lastSeq) }
    override fun onSleepTimer(remainingMs: Long, running: Boolean, atChapterEnd: Boolean) {
      eventListener?.onSleepTimer(remainingMs, running, atChapterEnd)
    }
    override fun onWord(id: Int, start: Int, end: Int) { eventListener?.onWord(id, start, end) }
    override fun onEnded() {
      mainHandler.post {
        releaseResources()
        updateSession()
      }
      // Nothing is listening when the app was closed: do not leave a finished read aloud notification behind
      if (eventListener == null) mainHandler.post { requestStop() }
      eventListener?.onEnded()
    }
    override fun onError(code: String, message: String) { eventListener?.onError(code, message) }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
    controller = TtsController(this).also {
      it.listener = forwardingListener
      it.init()
    }
    createChannel()
    session = MediaSessionCompat(this, "AbsTts").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() { startPlayback() }
        override fun onPause() { this@TtsService.controller.pause() }
        override fun onSkipToNext() { this@TtsService.controller.skip("sentence", 1) }
        override fun onSkipToPrevious() { this@TtsService.controller.skip("sentence", -1) }
        // Like the audiobook player the transport buttons are rewind and fast-forward: here a sentence back and forward
        override fun onFastForward() { this@TtsService.controller.skip("sentence", 1) }
        override fun onRewind() { this@TtsService.controller.skip("sentence", -1) }
        override fun onStop() { requestStop() }
        override fun onCustomAction(action: String?, extras: Bundle?) {
          when (action) {
            CUSTOM_REWIND -> this@TtsService.controller.skip("sentence", -1)
            CUSTOM_FORWARD -> this@TtsService.controller.skip("sentence", 1)
          }
        }
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        requestStop()
        return START_NOT_STICKY
      }
      ACTION_START -> {
        title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        author = intent.getStringExtra(EXTRA_AUTHOR) ?: ""
        loadCover(intent.getStringExtra(EXTRA_COVER_URI))
      }
      ACTION_KEY -> handleMediaKey(intent.getIntExtra(EXTRA_KEY_CODE, 0))
      else -> MediaButtonReceiver.handleIntent(session, intent)
    }
    updateSession()
    return START_NOT_STICKY
  }

  // --- Sleep timer: lives in the service so it still fires with the screen off ---
  private val mainHandler = Handler(Looper.getMainLooper())
  private val sleepHandler = mainHandler
  private var sleepEndsAt = 0L // SystemClock.elapsedRealtime, 0 = no timer
  private val sleepRunnable = Runnable {
    sleepEndsAt = 0
    controller.pause("sleep")
    eventListener?.onSleepTimer(0, false, false)
  }

  fun setSleepTimer(ms: Long) {
    cancelSleepTimer(notify = false)
    sleepEndsAt = SystemClock.elapsedRealtime() + ms
    sleepHandler.postDelayed(sleepRunnable, ms)
    eventListener?.onSleepTimer(ms, true, false)
  }

  /** Pause when reading reaches the section with index [untilSpine] (where the next chapter starts); the next section when not given */
  fun setSleepAtChapterEnd(untilSpine: Int?) {
    cancelSleepTimer(notify = false)
    controller.sleepUntilSpine = untilSpine ?: controller.currentSentence?.spine?.plus(1)
    eventListener?.onSleepTimer(0, controller.sleepUntilSpine != null, true)
  }

  fun adjustSleepTimer(deltaMs: Long) {
    if (sleepEndsAt == 0L) return
    val remaining = (sleepEndsAt - SystemClock.elapsedRealtime() + deltaMs).coerceAtLeast(1000)
    setSleepTimer(remaining)
  }

  fun cancelSleepTimer(notify: Boolean = true) {
    sleepHandler.removeCallbacks(sleepRunnable)
    sleepEndsAt = 0
    controller.sleepUntilSpine = null
    if (notify) eventListener?.onSleepTimer(0, false, false)
  }

  /** Media button routed here from the audiobook session callback while TTS owns playback */
  fun handleMediaKey(keyCode: Int) {
    when (keyCode) {
      android.view.KeyEvent.KEYCODE_MEDIA_PLAY -> startPlayback()
      android.view.KeyEvent.KEYCODE_MEDIA_PAUSE -> controller.pause()
      android.view.KeyEvent.KEYCODE_HEADSETHOOK, android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> if (controller.playing) controller.pause() else startPlayback()
      android.view.KeyEvent.KEYCODE_MEDIA_NEXT -> controller.skip("sentence", 1)
      android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS -> controller.skip("sentence", -1)
      android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> controller.skip("sentence", 1)
      android.view.KeyEvent.KEYCODE_MEDIA_REWIND -> controller.skip("sentence", -1)
      android.view.KeyEvent.KEYCODE_MEDIA_STOP -> requestStop()
    }
  }

  /** Request audio focus then play. */
  fun startPlayback() {
    if (!requestFocus()) {
      eventListener?.onError("audio_focus", "Could not get audio focus")
      return
    }
    controller.play()
  }

  private fun requestFocus(): Boolean {
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(attrs)
      .setOnAudioFocusChangeListener(focusListener)
      .build()
    focusRequest = req
    return audioManager.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun acquireResources() {
    if (wakeLock == null) {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "abs:tts").apply { setReferenceCounted(false) }
    }
    if (wakeLock?.isHeld == false) wakeLock?.acquire(12 * 60 * 60 * 1000L)
    if (!noisyRegistered) {
      registerReceiver(noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
      noisyRegistered = true
    }
  }

  private fun releaseResources() {
    if (wakeLock?.isHeld == true) wakeLock?.release()
    if (noisyRegistered) {
      unregisterReceiver(noisyReceiver)
      noisyRegistered = false
    }
    focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
  }

  private fun createChannel() {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      val channel = NotificationChannel(CHANNEL_ID, getString(R.string.tts_channel_name), NotificationManager.IMPORTANCE_LOW)
      channel.lightColor = android.graphics.Color.DKGRAY
      channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      nm.createNotificationChannel(channel)
    }
  }

  /** Same sources as the audiobook player: a downloaded item's local cover, otherwise the server's cover image */
  private fun loadCover(uriString: String?) {
    coverJob?.cancel()
    if (uriString.isNullOrBlank()) return
    coverJob = scope.launch {
      var uri = Uri.parse(uriString)
      if (uri.scheme == "file") {
        uri = FileProvider.getUriForFile(this@TtsService, "${BuildConfig.APPLICATION_ID}.fileprovider", java.io.File(uri.path ?: return@launch))
      }
      val bitmap = resolveUriAsBitmap(this@TtsService, uri)
      if (bitmap != null) {
        cover = bitmap
        updateSession()
      }
    }
  }

  private fun updateSession() {
    val playing = controller.playing
    val state = PlaybackStateCompat.Builder()
      .setActions(
        PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
          PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND or PlaybackStateCompat.ACTION_STOP
      )
      .addCustomAction(CUSTOM_REWIND, getString(R.string.tts_action_previous), com.google.android.exoplayer2.ui.R.drawable.exo_notification_rewind)
      .addCustomAction(CUSTOM_FORWARD, getString(R.string.tts_action_next), com.google.android.exoplayer2.ui.R.drawable.exo_notification_fastforward)
      .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
      .build()
    session.setPlaybackState(state)
    if (playing) silentAudio.start() else silentAudio.stop()
    session.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, author)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, cover)
        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, cover)
        .build()
    )

    val notification = buildNotification(playing)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun buildNotification(playing: Boolean): Notification {
    val openIntent = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    fun action(icon: Int, label: String, keyCode: Int): NotificationCompat.Action {
      val intent = Intent(this, TtsService::class.java).setAction(ACTION_KEY).putExtra(EXTRA_KEY_CODE, keyCode)
      val pending = PendingIntent.getForegroundService(this, keyCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      return NotificationCompat.Action(icon, label, pending)
    }

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      // The same small icon, large icon, priority and badge as the audiobook notification
      .setSmallIcon(R.drawable.icon_monochrome)
      .setLargeIcon(cover)
      .setBadgeIconType(NotificationCompat.BADGE_ICON_LARGE)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setContentTitle(title)
      .setContentText(author)
      .setContentIntent(openIntent)
      .setOnlyAlertOnce(true)
      .setOngoing(playing)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(action(com.google.android.exoplayer2.ui.R.drawable.exo_notification_rewind, getString(R.string.tts_action_previous), android.view.KeyEvent.KEYCODE_MEDIA_REWIND))
      .addAction(
        if (playing) action(com.google.android.exoplayer2.ui.R.drawable.exo_notification_pause, getString(R.string.tts_action_pause), android.view.KeyEvent.KEYCODE_MEDIA_PAUSE)
        else action(com.google.android.exoplayer2.ui.R.drawable.exo_notification_play, getString(R.string.tts_action_play), android.view.KeyEvent.KEYCODE_MEDIA_PLAY)
      )
      .addAction(action(com.google.android.exoplayer2.ui.R.drawable.exo_notification_fastforward, getString(R.string.tts_action_next), android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD))
      .setStyle(androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    return builder.build()
  }

  /** The app was swiped away: the JS side that feeds and displays this session is gone, so stop with it */
  override fun onTaskRemoved(rootIntent: Intent?) {
    // The home screen shortcut's own short-lived task (QuickPlayActivity), not the user swiping the app away
    if (com.audiobookshelf.app.QuickPlayActivity.isQuickPlayTask(rootIntent)) return super.onTaskRemoved(rootIntent)
    controller.pause()
    // "removed" lets the JS side keep the session so it can be offered again when the app is reopened
    requestStop("removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    // requestStop() already told the JS side. Only the system killing the service gets here with instance still set
    if (instance === this) eventListener?.onState(false, "stopped")
    sleepHandler.removeCallbacks(sleepRunnable)
    scope.cancel()
    releaseResources()
    silentAudio.stop()
    controller.release()
    session.isActive = false
    session.release()
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
