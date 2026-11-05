package com.audiobookshelf.app.core

import org.json.JSONArray
import org.json.JSONObject

/**
 * `store`: key-value, JSON strings in and out.
 *   get({collection, key}) -> {value: string | null}      put({collection, key, value})
 *   putMany({collection, items: [{key, value}]})            delete({collection, key})
 *   list({collection}) -> {items: [{key, value}]}           clear({collection})
 */
class StoreConnector : Connector {
  override fun call(method: String, args: JSONObject, reply: (Boolean, String) -> Unit) {
    val c = args.getString("collection")
    PaperMigration.ensure(c) // data that is still in Paper is moved first (waits for it)
    when (method) {
      "get" -> reply(true, JSONObject().put("value", Store.get(c, args.getString("key")) ?: JSONObject.NULL).toString())
      "put" -> { Store.put(c, args.getString("key"), args.getString("value")); reply(true, "") }
      "putMany" -> {
        val items = args.getJSONArray("items")
        Store.putAll(c, (0 until items.length()).map { items.getJSONObject(it).let { o -> Pair(o.getString("key"), o.getString("value")) } })
        reply(true, "")
      }
      "delete" -> { Store.delete(c, args.getString("key")); reply(true, "") }
      "clear" -> { Store.clear(c); reply(true, "") }
      "list" -> {
        val items = JSONArray()
        Store.all(c).forEach { (k, v) -> items.put(JSONObject().put("key", k).put("value", v)) }
        reply(true, JSONObject().put("items", items).toString())
      }
      else -> reply(false, "unknown store.$method")
    }
  }
}
