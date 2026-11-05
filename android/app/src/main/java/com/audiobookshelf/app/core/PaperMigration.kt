package com.audiobookshelf.app.core

import android.util.Log
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.plugins.AbsLog
import io.paperdb.Paper
import java.util.concurrent.ConcurrentHashMap

/**
 * One-time move of the data from Paper (Kryo, read with the old classes) to the core's store as JSON, one collection at a time.
 * Paper is left untouched for one release, so going back to the old build still works. The download queue is not moved (Phase 8).
 * Records Paper cannot read are skipped, as they were before. The core does the rest (defaults for missing settings, cleanup).
 *
 * The device data goes first and is waited for; the others are moved by a background thread right after, and anything that reads
 * a collection which is not moved yet waits for that collection ([ensure]). It is slow the first time (18 s for 2.3 MB of history
 * on the Pixel) because of Jackson's start-up cost, so nothing should wait for the big ones if it can be avoided.
 *
 * Remove this file, and the Jackson-annotated classes it needs, one release after it shipped.
 */
object PaperMigration {
  private const val TAG = "PaperMigration"
  private const val META = "meta"
  private val locks = ConcurrentHashMap<String, Any>()

  /** Big and rarely needed last */
  private val ORDER = listOf(DbManager.DEVICE, DbManager.LOCAL_LIBRARY_ITEMS, DbManager.LOCAL_FOLDERS, DbManager.LOCAL_MEDIA_PROGRESS,
    DbManager.PLAYBACK_SESSION, DbManager.LOG, DbManager.MEDIA_ITEM_HISTORY)

  /** Moves the device data now and the rest in the background */
  fun start() {
    ensure(DbManager.DEVICE)
    if (ORDER.all { Store.get(META, "paper:$it") != null }) return
    Thread({ ORDER.forEach { ensure(it) } }, "PaperMigration").start()
  }

  /** Returns when [collection] has been moved from Paper (at once when it was moved before) */
  fun ensure(collection: String) {
    if (collection !in ORDER) return
    val key = "paper:$collection"
    if (Store.get(META, key) != null) return
    synchronized(locks.getOrPut(collection) { Any() }) {
      if (Store.get(META, key) != null) return
      val started = System.currentTimeMillis()
      val count = when (collection) {
        DbManager.DEVICE -> copy<DeviceData>(collection, listOf("data"))
        DbManager.LOCAL_LIBRARY_ITEMS -> copy<LocalLibraryItem>(collection, null)
        DbManager.LOCAL_FOLDERS -> copy<LocalFolder>(collection, null)
        DbManager.LOCAL_MEDIA_PROGRESS -> copy<LocalMediaProgress>(collection, null)
        DbManager.MEDIA_ITEM_HISTORY -> copy<MediaItemHistory>(collection, null)
        DbManager.PLAYBACK_SESSION -> copy<PlaybackSession>(collection, null)
        else -> copy<AbsLog>(collection, null)
      }
      Store.putAll(META, listOf(Pair(key, System.currentTimeMillis().toString())), silent = true)
      Log.i(TAG, "Moved $collection from Paper: $count in ${System.currentTimeMillis() - started} ms")
    }
  }

  private inline fun <reified T : Any> copy(book: String, onlyKeys: List<String>?): String {
    val items = ArrayList<Pair<String, String>>()
    var skipped = 0
    for (key in onlyKeys ?: Paper.book(book).allKeys) {
      try {
        val value: T = Paper.book(book).read(key) ?: continue
        items.add(Pair(key, DbManager.mapper.writeValueAsString(value)))
      } catch (e: Exception) {
        skipped++
        Log.w(TAG, "Skipping $book/$key: ${e.message}")
      }
    }
    Store.putAll(book, items, silent = true)
    return "${items.size} records${if (skipped > 0) " (+$skipped skipped)" else ""}"
  }
}
