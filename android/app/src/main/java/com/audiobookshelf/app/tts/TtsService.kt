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
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
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
    const val EXTRA_TITLE = "title"
    const val EXTRA_AUTHOR = "author"

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
  private var title = ""
  private var author = ""
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
      if (playing) acquireResources() else releaseResources()
      updateSession()
      eventListener?.onState(playing, reason)
    }
    override fun onNeedMore(streamId: Int, lastSeq: Int) { eventListener?.onNeedMore(streamId, lastSeq) }
    override fun onSleepTimer(remainingMs: Long, running: Boolean, atChapterEnd: Boolean) {
      eventListener?.onSleepTimer(remainingMs, running, atChapterEnd)
    }
    override fun onEnded() {
      releaseResources()
      updateSession()
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
        override fun onFastForward() { this@TtsService.controller.skip("paragraph", 1) }
        override fun onRewind() { this@TtsService.controller.skip("paragraph", -1) }
        override fun onStop() { requestStop() }
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
      }
      else -> MediaButtonReceiver.handleIntent(session, intent)
    }
    updateSession()
    return START_NOT_STICKY
  }

  // --- Sleep timer: lives in the service so it still fires with the screen off ---
  private val sleepHandler = Handler(Looper.getMainLooper())
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

  /** Pause when the current chapter (spine item) is finished */
  fun setSleepAtChapterEnd() {
    cancelSleepTimer(notify = false)
    controller.sleepSpine = controller.currentSentence?.spine
    eventListener?.onSleepTimer(0, controller.sleepSpine != null, true)
  }

  fun adjustSleepTimer(deltaMs: Long) {
    if (sleepEndsAt == 0L) return
    val remaining = (sleepEndsAt - SystemClock.elapsedRealtime() + deltaMs).coerceAtLeast(1000)
    setSleepTimer(remaining)
  }

  fun cancelSleepTimer(notify: Boolean = true) {
    sleepHandler.removeCallbacks(sleepRunnable)
    sleepEndsAt = 0
    controller.sleepSpine = null
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
      android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> controller.skip("paragraph", 1)
      android.view.KeyEvent.KEYCODE_MEDIA_REWIND -> controller.skip("paragraph", -1)
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
      val channel = NotificationChannel(CHANNEL_ID, "Read aloud", NotificationManager.IMPORTANCE_LOW)
      nm.createNotificationChannel(channel)
    }
  }

  private fun updateSession() {
    val playing = controller.playing
    val state = PlaybackStateCompat.Builder()
      .setActions(
        PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or PlaybackStateCompat.ACTION_PLAY_PAUSE or
          PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
          PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND or PlaybackStateCompat.ACTION_STOP
      )
      .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
      .build()
    session.setPlaybackState(state)
    session.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, author)
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
    fun action(icon: Int, label: String, code: Long) =
      NotificationCompat.Action(icon, label, MediaButtonReceiver.buildMediaButtonPendingIntent(this, code))

    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(author)
      .setContentIntent(openIntent)
      .setOnlyAlertOnce(true)
      .setOngoing(playing)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(action(android.R.drawable.ic_media_previous, "Previous", PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
      .addAction(
        if (playing) action(android.R.drawable.ic_media_pause, "Pause", PlaybackStateCompat.ACTION_PAUSE)
        else action(android.R.drawable.ic_media_play, "Play", PlaybackStateCompat.ACTION_PLAY)
      )
      .addAction(action(android.R.drawable.ic_media_next, "Next", PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
      .setStyle(androidx.media.app.NotificationCompat.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0, 1, 2))
    return builder.build()
  }

  /** The app was swiped away: the JS side that feeds and displays this session is gone, so stop with it */
  override fun onTaskRemoved(rootIntent: Intent?) {
    controller.pause()
    // "removed" lets the JS side keep the session so it can be offered again when the app is reopened
    requestStop("removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    // requestStop() already told the JS side. Only the system killing the service gets here with instance still set
    if (instance === this) eventListener?.onState(false, "stopped")
    sleepHandler.removeCallbacks(sleepRunnable)
    releaseResources()
    controller.release()
    session.isActive = false
    session.release()
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
