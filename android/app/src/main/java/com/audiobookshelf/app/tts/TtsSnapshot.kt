package com.audiobookshelf.app.tts

import android.content.Context

/**
 * What the read-aloud session looks like, saved by the web part while it reads. Native code (the Pebble watch)
 * cannot see the web part's storage, and needs to know which EPUB was read last and how far it got.
 */
data class TtsSnapshot(
  val libraryItemId: String,
  val title: String,
  val chapter: String,
  val chapterNumber: Int,
  val chapterCount: Int,
  /** 0-100, whole book */
  val progress: Double,
  /** When the web part last saved it: while reading that is "now", so after pausing it is when reading stopped */
  val updatedAt: Long,
  /** Everything the web part needs to open the book again (JSON): lets the Pebble watch start reading with the app closed */
  val session: String = ""
) {
  companion object {
    private const val PREFS = "tts_snapshot"

    fun save(context: Context, snapshot: TtsSnapshot) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .putString("id", snapshot.libraryItemId)
        .putString("title", snapshot.title)
        .putString("chapter", snapshot.chapter)
        .putInt("chapterNumber", snapshot.chapterNumber)
        .putInt("chapterCount", snapshot.chapterCount)
        .putFloat("progress", snapshot.progress.toFloat())
        .putLong("updatedAt", snapshot.updatedAt)
        .putString("session", snapshot.session)
        .apply()
    }

    fun load(context: Context): TtsSnapshot? {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val id = prefs.getString("id", null) ?: return null
      return TtsSnapshot(
        id,
        prefs.getString("title", "") ?: "",
        prefs.getString("chapter", "") ?: "",
        prefs.getInt("chapterNumber", 0),
        prefs.getInt("chapterCount", 0),
        prefs.getFloat("progress", 0f).toDouble(),
        prefs.getLong("updatedAt", 0),
        prefs.getString("session", "") ?: ""
      )
    }

    fun clear(context: Context) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
  }
}
