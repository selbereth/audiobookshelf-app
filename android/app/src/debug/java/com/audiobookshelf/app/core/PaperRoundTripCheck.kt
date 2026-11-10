package com.audiobookshelf.app.core

import android.content.Context
import android.util.Log
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.managers.DbManager
import com.audiobookshelf.app.plugins.AbsLog
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.paperdb.Paper
import java.lang.reflect.Modifier

/**
 * Debug builds only. Before the data moves from Paper (Kryo, the Kotlin objects as they are) to JSON in the new store: reads every
 * record from Paper, writes it to JSON with Jackson, reads it back and compares every field (private ones too). Logs the
 * differences with tag PaperCheck. Nothing is written anywhere.
 */
object PaperRoundTripCheck {
  private const val TAG = "PaperCheck"
  private val mapper = jacksonObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())

  fun run(context: Context) {
    DbManager.initialize(context)
    try {
    check<DeviceData>("device", "data")
    check<LocalLibraryItem>("localLibraryItems")
    check<LocalFolder>("localFolders")
    check<LocalMediaProgress>("localMediaProgress")
    check<MediaItemHistory>("mediaItemHistory")
    check<PlaybackSession>("playbackSession")
    check<AbsLog>("log")
    Log.i(TAG, "done")
    } catch (t: Throwable) {
      Log.e(TAG, "check died: ${t.javaClass.name}: ${t.message}", t)
    }
  }

  private inline fun <reified T : Any> check(book: String, onlyKey: String? = null) {
    var ok = 0
    var bad = 0
    var unreadable = 0
    Log.i(TAG, "$book: starting")
    val keys = if (onlyKey != null) listOf(onlyKey) else Paper.book(book).allKeys
    for (key in keys) {
      val original: T? = try { Paper.book(book).read<T>(key) } catch (e: Exception) { unreadable++; Log.w(TAG, "$book/$key unreadable in Paper: ${e.message}"); continue }
      if (original == null) continue
      val diffs = mutableListOf<String>()
      try {
        val t0 = System.currentTimeMillis()
        val json = mapper.writeValueAsString(original)
        val t1 = System.currentTimeMillis()
        val back = mapper.readValue(json, T::class.java)
        val t2 = System.currentTimeMillis()
        compare(original, back, "$book/$key", diffs, 0)
        if (book == "mediaItemHistory" || t2 - t0 > 2000) Log.i(TAG, "$book/${key.take(20)}: json ${json.length / 1024} KB, write ${t1 - t0} ms, read ${t2 - t1} ms, compare ${System.currentTimeMillis() - t2} ms")
      } catch (e: Exception) {
        diffs.add("round trip failed: ${e.javaClass.simpleName}: ${e.message?.take(300)}")
      }
      if (diffs.isEmpty()) ok++ else { bad++; if (bad <= 3) diffs.take(8).forEach { Log.w(TAG, "$book/$key: $it") } }
    }
    Log.i(TAG, "$book: ${keys.size} records, identical=$ok, different=$bad, unreadable in Paper=$unreadable")
  }

  private fun compare(a: Any?, b: Any?, path: String, diffs: MutableList<String>, depth: Int) {
    if (diffs.size > 20 || depth > 25) return
    if (a == null || b == null) { if (a != b) diffs.add("$path: $a vs $b"); return }
    if (a.javaClass != b.javaClass && !(a is Collection<*> && b is Collection<*>) && !(a is Map<*, *> && b is Map<*, *>)) { diffs.add("$path: class ${a.javaClass.simpleName} vs ${b.javaClass.simpleName}"); return }
    when {
      a is String || a is Number || a is Boolean || a is Char || a is Enum<*> -> if (a != b) diffs.add("$path: $a vs $b")
      a is Collection<*> -> {
        val bl = (b as Collection<*>).toList(); val al = a.toList()
        if (al.size != bl.size) diffs.add("$path: size ${al.size} vs ${bl.size}") else al.indices.forEach { compare(al[it], bl[it], "$path[$it]", diffs, depth + 1) }
      }
      a is Map<*, *> -> {
        val bm = b as Map<*, *>
        if (a.size != bm.size) diffs.add("$path: map size ${a.size} vs ${bm.size}") else a.forEach { (k, v) -> compare(v, bm[k], "$path.$k", diffs, depth + 1) }
      }
      else -> {
        var c: Class<*>? = a.javaClass
        while (c != null && c != Any::class.java) {
          for (f in c.declaredFields) {
            if (Modifier.isStatic(f.modifiers) || f.isSynthetic || f.name == "\$stable") continue
            if (f.type.name.startsWith("android.")) continue // Bitmap, Uri: runtime only
            f.isAccessible = true
            compare(f.get(a), f.get(b), "$path.${f.name}", diffs, depth + 1)
          }
          c = c.superclass
        }
      }
    }
  }
}
