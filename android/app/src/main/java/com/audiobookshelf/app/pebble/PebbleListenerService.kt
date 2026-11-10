package com.audiobookshelf.app.pebble

import android.util.Log
import com.audiobookshelf.app.managers.DbManager
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The Pebble app binds to this service when the watchapp is opened, which starts this app's process if it is not running. This
 * is only the transport: a message from the watch is handed to the shared logic (`utils/pebble/hub.js`, run by [PebbleHost])
 * as JSON, and the messages the logic wants sent are written into the watch's format by [send]. It decides nothing.
 */
class PebbleListenerService : BasePebbleListenerService() {
  private val tag = "PebbleListenerService"
  private lateinit var sender: DefaultPebbleSender

  override fun onCreate() {
    super.onCreate()
    // The app's database is normally opened by the main screen, which is not running when the watch starts the app
    DbManager.initialize(applicationContext)
    sender = DefaultPebbleSender(applicationContext)
    instance = this
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    PebbleHost.stop()
    // The library unbinds a connection that was never opened when nothing was sent, which throws
    runCatching { sender.close() }
    super.onDestroy()
  }

  override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
    if (watchappUUID != PebbleProtocol.WATCHAPP_UUID) return
    PebbleListenerService.watch = watch
    coroutineScope.launch { PebbleHost.call(applicationContext, "opened") }
  }

  override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
    if (watchappUUID != PebbleProtocol.WATCHAPP_UUID) return
    coroutineScope.launch { PebbleHost.call(applicationContext, "closed") }
  }

  override suspend fun onMessageReceived(watchappUUID: UUID, data: PebbleDictionary, watch: WatchIdentifier): ReceiveResult {
    Log.d(tag, "Message from the watch for $watchappUUID: $data")
    if (watchappUUID != PebbleProtocol.WATCHAPP_UUID) return ReceiveResult.Nack
    PebbleListenerService.watch = watch
    // By key number: what a key means is the shared logic's business
    val message = JSONObject()
    data.forEach { (key, item) ->
      when (val value = item.value) {
        is UByte -> message.put(key.toString(), value.toInt())
        is Byte -> message.put(key.toString(), value.toInt())
        is UShort -> message.put(key.toString(), value.toInt())
        is Short -> message.put(key.toString(), value.toInt())
        is UInt -> message.put(key.toString(), value.toLong())
        is Int -> message.put(key.toString(), value)
        is String -> message.put(key.toString(), value)
        else -> {}
      }
    }
    // Acknowledge at once (the watch times out otherwise) and let the logic answer when it has done it
    coroutineScope.launch { PebbleHost.call(applicationContext, "handle", JSONArray().put(message)) }
    return ReceiveResult.Ack
  }

  private suspend fun sendToWatch(items: JSONArray) {
    val target = watch
    val message = HashMap<UInt, PebbleDictionaryItem>()
    for (i in 0 until items.length()) {
      val item = items.getJSONArray(i)
      val key = item.getInt(0).toUInt()
      message[key] = when (item.getString(1)) {
        "u8" -> PebbleDictionaryItem.UInt8(item.getInt(2).toUByte())
        "u16" -> PebbleDictionaryItem.UInt16(item.getInt(2).toUShort())
        "u32" -> PebbleDictionaryItem.UInt32(item.getLong(2).toUInt())
        else -> PebbleDictionaryItem.Text(item.getString(2))
      }
    }
    if (target == null) {
      Log.i(tag, "No watch to send to: $items")
      return
    }
    val result = sender.sendDataToPebble(PebbleProtocol.WATCHAPP_UUID, message, listOf(target))
    Log.d(tag, "Sent $items: $result")
  }

  companion object {
    @Volatile private var instance: PebbleListenerService? = null
    @Volatile private var watch: WatchIdentifier? = null

    /** A message the shared logic wants sent to the watch: [[key number, "u8" | "u16" | "u32" | "text", value], ...] */
    suspend fun send(items: JSONArray) {
      val service = instance
      if (service == null) {
        Log.i("PebbleListenerService", "Not connected to the Pebble app: $items")
        return
      }
      service.sendToWatch(items)
    }
  }
}
