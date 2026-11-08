package com.audiobookshelf.app.core

import android.content.Context

/**
 * The switches that say which path does a job (Phases 4b-3, 5, 6, 7, 8). Off (the default): the Kotlin path does it, as before.
 * On: the core does it, and the Kotlin path is silent (no double writes or messages). They are read ONCE per app process, on the
 * first load, so Kotlin and the core always agree; a change written by the debug receiver applies at the next start of the app
 * (force-stop, then start it). Set from a debug build: adb shell am broadcast ... --es action coreSaver --ez on true
 */
object CoreSwitch {
  private const val PREFS = "core"
  private const val KEY = "coreSaver"
  private const val SLEEP_KEY = "coreSleep"
  private const val UI_KEY = "coreUi"
  private const val PEBBLE_KEY = "corePebble"
  private const val DOWNLOAD_KEY = "coreDownload"
  private const val PLAYER_KEY = "corePlayer"
  private const val TTS_KEY = "coreTts"

  @Volatile
  var coreSaver = false
    private set

  /** Phase 5: the core's sleep timer. Kotlin's SleepTimerManager is silent while on. */
  @Volatile
  var coreSleep = false
    private set

  /** Phase 6: the UI mirrors the device data the core saves (the `deviceChanged` event). */
  @Volatile
  var coreUi = false
    private set

  /** Phase 7: the Pebble watch logic runs in the core (utils/core/modules/pebble.js). Off: PebbleHost runs utils/pebble/hub.js as before. */
  @Volatile
  var corePebble = false
    private set

  /** Phase 8 (slice 1): the core decides the download part step, the retry counts and the free-space check. Off: DownloadItemManager's own rules */
  @Volatile
  var coreDownload = false
    private set

  /** Phase 9 (slice 1): the core decides the auto-rewind after a pause (utils/core/modules/player.js). Off: PlayerListener's own rule */
  @Volatile
  var corePlayer = false
    private set

  /** Phase 10 (slice B): the core decides the read-aloud's sleep timer (utils/core/modules/tts.js). Off: TtsService's own timer */
  @Volatile
  var coreTts = false
    private set

  private var loaded = false

  /** Reads the switches the first time only: a later call (CoreHost.start runs often) does not change them mid-process. */
  @Synchronized
  fun load(context: Context) {
    if (loaded) return
    loaded = true
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    coreSaver = prefs.getBoolean(KEY, false)
    coreSleep = prefs.getBoolean(SLEEP_KEY, false)
    coreUi = prefs.getBoolean(UI_KEY, false)
    corePebble = prefs.getBoolean(PEBBLE_KEY, false)
    coreDownload = prefs.getBoolean(DOWNLOAD_KEY, false)
    corePlayer = prefs.getBoolean(PLAYER_KEY, false)
    coreTts = prefs.getBoolean(TTS_KEY, false)
  }

  fun writeTts(context: Context, on: Boolean) = put(context, TTS_KEY, on)

  fun writeUi(context: Context, on: Boolean) = put(context, UI_KEY, on)

  fun writeSleep(context: Context, on: Boolean) = put(context, SLEEP_KEY, on)

  fun write(context: Context, on: Boolean) = put(context, KEY, on)

  fun writePebble(context: Context, on: Boolean) = put(context, PEBBLE_KEY, on)

  fun writeDownload(context: Context, on: Boolean) = put(context, DOWNLOAD_KEY, on)

  fun writePlayer(context: Context, on: Boolean) = put(context, PLAYER_KEY, on)

  private fun put(context: Context, key: String, on: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(key, on).commit()
  }
}
