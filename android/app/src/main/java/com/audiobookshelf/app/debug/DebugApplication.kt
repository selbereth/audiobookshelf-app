package com.audiobookshelf.app.debug

import android.app.Application

/** Starts [DebugLog] before any Activity, service or Pebble listener runs (the process can start without the screen). */
class DebugApplication : Application() {
  override fun onCreate() {
    super.onCreate()
    DebugLog.init(this)
  }

  override fun onTrimMemory(level: Int) {
    super.onTrimMemory(level)
    DebugLog.trimMemory(level)
  }
}
