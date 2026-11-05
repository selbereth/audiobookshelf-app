package com.audiobookshelf.app.core

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * The key-value store behind the `store` connector: collection + key -> a JSON string. It knows nothing about what the JSON means
 * (the schema and every rule are in the core, utils/core/modules/db.js). The Kotlin DbManager reads and writes the same rows for
 * the parts of the app that have not moved to the core yet.
 */
object Store {
  private var db: SQLiteDatabase? = null

  /** Called after every write with the collection name (DeviceManager reloads its copy of the device data on "device") */
  @Volatile var onChange: ((String) -> Unit)? = null

  private class Helper(ctx: Context) : SQLiteOpenHelper(ctx, "core-store.db", null, 1) {
    override fun onCreate(d: SQLiteDatabase) {
      d.execSQL("CREATE TABLE kv (collection TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (collection, k)) WITHOUT ROWID")
    }

    override fun onUpgrade(d: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}
  }

  @Synchronized
  fun init(ctx: Context) {
    if (db == null) db = Helper(ctx.applicationContext).writableDatabase
  }

  private val d get() = db ?: throw IllegalStateException("Store not initialized")

  fun get(collection: String, key: String): String? =
    d.rawQuery("SELECT v FROM kv WHERE collection = ? AND k = ?", arrayOf(collection, key)).use { if (it.moveToFirst()) it.getString(0) else null }

  fun all(collection: String): List<Pair<String, String>> =
    d.rawQuery("SELECT k, v FROM kv WHERE collection = ?", arrayOf(collection)).use { c ->
      val out = ArrayList<Pair<String, String>>(c.count)
      while (c.moveToNext()) out.add(Pair(c.getString(0), c.getString(1)))
      out
    }

  fun keys(collection: String): List<String> =
    d.rawQuery("SELECT k FROM kv WHERE collection = ?", arrayOf(collection)).use { c ->
      val out = ArrayList<String>(c.count)
      while (c.moveToNext()) out.add(c.getString(0))
      out
    }

  fun put(collection: String, key: String, json: String) = putAll(collection, listOf(Pair(key, json)))

  /** One transaction: all of them or none */
  fun putAll(collection: String, items: List<Pair<String, String>>, silent: Boolean = false) {
    d.beginTransaction()
    try {
      for ((k, v) in items) {
        val values = ContentValues().apply { put("collection", collection); put("k", k); put("v", v) }
        d.insertWithOnConflict("kv", null, values, SQLiteDatabase.CONFLICT_REPLACE)
      }
      d.setTransactionSuccessful()
    } finally {
      d.endTransaction()
    }
    if (!silent) onChange?.invoke(collection)
  }

  fun delete(collection: String, key: String) {
    d.delete("kv", "collection = ? AND k = ?", arrayOf(collection, key))
    onChange?.invoke(collection)
  }

  fun clear(collection: String) {
    d.delete("kv", "collection = ?", arrayOf(collection))
    onChange?.invoke(collection)
  }
}
