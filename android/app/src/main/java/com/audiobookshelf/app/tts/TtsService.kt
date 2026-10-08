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
import android.os.PowerManager
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

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        if (controller.playing) controller.pause("focus")
      }
    }
  }

  private val forwardingListener = object : TtsController.Listener {
    override fun onSentence(s: TtsSentence) {
      updateSession()
      eventListener?.onSentence(s)
    }
    override fun onState(playing: Boolean, reason: String?) {
      if (playing) acquireResources() else releaseResources()
      updateSession()
      eventListener?.onState(playing, reason)
    }
    override fun onNeedMore(streamId: Int, lastSeq: Int) { eventListener?.onNeedMore(streamId, lastSeq) }
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
        override fun onStop() { stopSelf() }
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopSelf()
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

  override fun onDestroy() {
    releaseResources()
    controller.release()
    session.isActive = false
    session.release()
    instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
