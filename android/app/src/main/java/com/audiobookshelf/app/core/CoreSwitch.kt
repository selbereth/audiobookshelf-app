package com.audiobookshelf.app.core

import android.content.Context

/**
 * The switch that says which path saves playback progress (Phase 4b-3). Off (the default): Kotlin's MediaProgressSyncer saves
 * and sends, as before. On: the core's saver does, and Kotlin's MediaProgressSyncer does not (no double writes). It is read once
 * per app process, when the core starts, so Kotlin and the core always agree; a change applies at the next start of the app.
 * Set from a debug build: adb shell am broadcast ... --es action coreSaver --ez on true
 */
object CoreSwitch {
  private const val PREFS = "core"
  private const val KEY = "coreSaver"
  private const val SLEEP_KEY = "coreSleep"

  @Volatile
  var coreSaver = false
    private set

  /** Phase 5: the core's sleep timer. Same rules as coreSaver: read at start, default off, Kotlin's SleepTimerManager is silent while on. */
  @Volatile
  var coreSleep = false
    private set

  fun load(context: Context) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    coreSaver = prefs.getBoolean(KEY, false)
    coreSleep = prefs.getBoolean(SLEEP_KEY, false)
  }

  fun writeSleep(context: Context, on: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(SLEEP_KEY, on).commit()
  }

  fun write(context: Context, on: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, on).commit()
  }
}
