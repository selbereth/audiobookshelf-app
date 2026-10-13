package com.audiobookshelf.app.pebble

import android.util.Log
import com.audiobookshelf.app.managers.DbManager
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.UUID

/**
 * The Pebble app binds to this service when the watchapp is opened, which starts this app's process if it is not
 * running. Messages from the watch are turned into commands for the audiobook player, and the answer (what is
 * playing) is sent back to the watch.
 */
class PebbleListenerService : BasePebbleListenerService() {
  private val tag = "PebbleListenerService"
  private lateinit var controller: PebbleController
  private lateinit var sender: DefaultPebbleSender
  private var lastStatusSentAt = 0L
  private var watcher: Job? = null

  override fun onCreate() {
    super.onCreate()
    // The app's database is normally opened by the main screen, which is not running when the watch starts the app
    DbManager.initialize(applicationContext)
    controller = PebbleController(applicationContext)
    sender = DefaultPebbleSender(applicationContext)
  }

  override fun onDestroy() {
    watcher?.cancel()
    controller.release()
    // The library unbinds a connection that was never opened when nothing was sent, which throws
    runCatching { sender.close() }
    super.onDestroy()
  }

  override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
    if (watchappUUID != PebbleProtocol.WATCHAPP_UUID) return
    coroutineScope.launch { sendStatus(controller.status(), watch) }
    watchPlayer(watch)
  }

  /**
   * While the watchapp is open, tell the watch when the player changes without the watch asking: started or paused
   * from the phone or a headset, a new chapter, or progress (the bar on the watch moves in steps of this size).
   */
  private fun watchPlayer(watch: WatchIdentifier) {
    watcher?.cancel()
    watcher = coroutineScope.launch {
      var last: PebbleStatus? = null
      while (true) {
        delay(1000)
        val status = controller.status()
        val before = last
        if (before == null) {
          last = status
          continue
        }
        // A command from the watch is answered by its own message; LOADING is followed by waitUntilPlaying
        if (status.state == PebbleProtocol.STATE_LOADING) continue
        val progress = kotlin.math.abs(status.positionSeconds - before.positionSeconds) >= PROGRESS_STEP_SECONDS
        if (status.state != before.state || status.title != before.title || status.chapter != before.chapter || progress) {
          last = status
          sendStatus(status, watch)
        }
      }
    }
  }

  override suspend fun onMessageReceived(watchappUUID: UUID, data: PebbleDictionary, watch: WatchIdentifier): ReceiveResult {
    Log.d(tag, "Message from the watch for $watchappUUID: $data")
    if (watchappUUID != PebbleProtocol.WATCHAPP_UUID) return ReceiveResult.Nack
    // The number can arrive as any integer type, whatever the watch wrote it as
    val command = when (val value = data[PebbleProtocol.KEY_COMMAND]?.value) {
      is UByte -> value.toInt()
      is Byte -> value.toInt()
      is UShort -> value.toInt()
      is Short -> value.toInt()
      is UInt -> value.toInt()
      is Int -> value
      else -> null
    } ?: return ReceiveResult.Nack
    Log.d(tag, "Command from the watch: $command")
    // Acknowledge at once (the watch times out otherwise) and answer when the player has done it
    coroutineScope.launch {
      // The status was just sent when the app opened: the watch's own hello needs no second copy (it would refuse it)
      if (command == PebbleProtocol.CMD_HELLO && System.currentTimeMillis() - lastStatusSentAt < 2000) return@launch
      val status = controller.handle(command)
      sendStatus(status, watch)
      if (status.state == PebbleProtocol.STATE_LOADING) sendStatus(controller.waitUntilPlaying(), watch)
    }
    return ReceiveResult.Ack
  }

  private suspend fun sendStatus(status: PebbleStatus, watch: WatchIdentifier) {
    lastStatusSentAt = System.currentTimeMillis()
    val message: PebbleDictionary = mapOf(
      PebbleProtocol.KEY_STATE to PebbleDictionaryItem.UInt8(status.state),
      PebbleProtocol.KEY_TITLE to PebbleDictionaryItem.Text(status.title),
      PebbleProtocol.KEY_CHAPTER to PebbleDictionaryItem.Text(status.chapter),
      PebbleProtocol.KEY_POSITION to PebbleDictionaryItem.UInt32(status.positionSeconds.toUInt()),
      PebbleProtocol.KEY_DURATION to PebbleDictionaryItem.UInt32(status.durationSeconds.toUInt()),
      PebbleProtocol.KEY_CHAPTER_NUMBER to PebbleDictionaryItem.UInt16(status.chapterNumber.toUShort()),
      PebbleProtocol.KEY_CHAPTER_COUNT to PebbleDictionaryItem.UInt16(status.chapterCount.toUShort())
    )
    val result = sender.sendDataToPebble(PebbleProtocol.WATCHAPP_UUID, message, listOf(watch))
    Log.d(tag, "Sent status ${status.state} '${status.title}' chapter ${status.chapterNumber}/${status.chapterCount} at ${status.positionSeconds}s: $result")
  }

  private companion object {
    const val PROGRESS_STEP_SECONDS = 20
  }
}
