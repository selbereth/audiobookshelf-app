package com.audiobookshelf.app.core

import org.json.JSONObject

/**
 * A native connector: calls the Android API and turns the result into JSON. No app logic: it never chooses, retries, merges,
 * schedules, counts or works out times. [call] may run on any thread; [reply] may be called from any thread, once.
 */
fun interface Connector {
  fun call(method: String, args: JSONObject, reply: (ok: Boolean, json: String) -> Unit)
}
