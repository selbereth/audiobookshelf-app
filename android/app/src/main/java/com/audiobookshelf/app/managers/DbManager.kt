package com.audiobookshelf.app.managers

import android.content.Context
import android.util.Log
import com.audiobookshelf.app.core.PaperMigration
import com.audiobookshelf.app.core.Store
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.models.DownloadItem
import com.audiobookshelf.app.plugins.AbsLog
import com.audiobookshelf.app.plugins.AbsLogger
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import io.paperdb.Paper

/**
 * Typed access for the Kotlin that has not moved to the core yet. The data lives in the core's store (JSON, `core/Store.kt`), the
 * same rows the core reads and writes; the schema and every rule (cleanup, defaults, finished/merge rules) are in the core
 * (utils/core/modules/db.js). Nothing here decides anything. The download queue stays in Paper until the downloads move (Phase 8).
 */
class DbManager {
  val tag = "DbManager"

  companion object {
    private var isDbInitialized = false
    val mapper = jacksonObjectMapper()
            .enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)

    const val DEVICE = "device"
    const val LOCAL_LIBRARY_ITEMS = "localLibraryItems"
    const val LOCAL_FOLDERS = "localFolders"
    const val LOCAL_MEDIA_PROGRESS = "localMediaProgress"
    const val MEDIA_ITEM_HISTORY = "mediaItemHistory"
    const val PLAYBACK_SESSION = "playbackSession"
    const val LOG = "log"

    @Synchronized
    fun initialize(ctx: Context) {
      if (isDbInitialized) return
      Paper.init(ctx)
      Store.init(ctx)
      PaperMigration.start()
      isDbInitialized = true
      Log.i("DbManager", "Initialized store")
    }
  }

  private inline fun <reified T> read(collection: String, key: String): T? {
    PaperMigration.ensure(collection)
    val json = Store.get(collection, key) ?: return null
    return try {
      mapper.readValue(json, T::class.java)
    } catch (e: Exception) {
      Log.e(tag, "Could not read $collection/$key: ${e.message}")
      null
    }
  }

  private inline fun <reified T> readAll(collection: String): MutableList<T> {
    PaperMigration.ensure(collection)
    val out = mutableListOf<T>()
    Store.all(collection).forEach { (key, json) ->
      try {
        out.add(mapper.readValue(json, T::class.java))
      } catch (e: Exception) {
        Log.e(tag, "Could not read $collection/$key: ${e.message}")
      }
    }
    return out
  }

  private fun write(collection: String, key: String, value: Any) {
    PaperMigration.ensure(collection)
    Store.put(collection, key, mapper.writeValueAsString(value))
  }

  fun getDeviceData(): DeviceData {
    return read(DEVICE, "data") ?: DeviceData(mutableListOf(), null, DeviceSettings.default(), null)
  }
  fun saveDeviceData(deviceData: DeviceData) {
    write(DEVICE, "data", deviceData)
  }

  fun getLocalLibraryItems(mediaType: String? = null): MutableList<LocalLibraryItem> {
    val all = readAll<LocalLibraryItem>(LOCAL_LIBRARY_ITEMS)
    return if (mediaType.isNullOrEmpty()) all else all.filter { it.mediaType == mediaType }.toMutableList()
  }

  fun getLocalLibraryItemsInFolder(folderId: String): List<LocalLibraryItem> {
    return getLocalLibraryItems().filter { it.folderId == folderId }
  }

  fun getLocalLibraryItemByLId(libraryItemId: String): LocalLibraryItem? {
    return getLocalLibraryItems().find { it.libraryItemId == libraryItemId }
  }

  fun getLocalLibraryItem(localLibraryItemId: String): LocalLibraryItem? {
    return read(LOCAL_LIBRARY_ITEMS, localLibraryItemId)
  }

  fun getLocalLibraryItemWithEpisode(podcastEpisodeId: String): LibraryItemWithEpisode? {
    var podcastEpisode: PodcastEpisode? = null
    val localLibraryItem =
            getLocalLibraryItems("podcast").find { localLibraryItem ->
              val podcast = localLibraryItem.media as Podcast
              podcastEpisode = podcast.episodes?.find { it.id == podcastEpisodeId }
              podcastEpisode != null
            }
    return if (localLibraryItem != null) {
      LibraryItemWithEpisode(localLibraryItem, podcastEpisode!!)
    } else {
      null
    }
  }

  fun removeLocalLibraryItem(localLibraryItemId: String) {
    PaperMigration.ensure(LOCAL_LIBRARY_ITEMS)
    Store.delete(LOCAL_LIBRARY_ITEMS, localLibraryItemId)
  }

  fun saveLocalLibraryItems(localLibraryItems: List<LocalLibraryItem>) {
    PaperMigration.ensure(LOCAL_LIBRARY_ITEMS)
    Store.putAll(LOCAL_LIBRARY_ITEMS, localLibraryItems.map { Pair(it.id, mapper.writeValueAsString(it)) })
  }

  fun saveLocalLibraryItem(localLibraryItem: LocalLibraryItem) {
    write(LOCAL_LIBRARY_ITEMS, localLibraryItem.id, localLibraryItem)
  }

  fun saveLocalFolder(localFolder: LocalFolder) {
    write(LOCAL_FOLDERS, localFolder.id, localFolder)
  }

  fun getLocalFolder(folderId: String): LocalFolder? {
    return read(LOCAL_FOLDERS, folderId)
  }

  fun getAllLocalFolders(): List<LocalFolder> {
    return readAll(LOCAL_FOLDERS)
  }

  fun removeLocalFolder(folderId: String) {
    PaperMigration.ensure(LOCAL_FOLDERS)
    getLocalLibraryItemsInFolder(folderId).forEach { Store.delete(LOCAL_LIBRARY_ITEMS, it.id) }
    Store.delete(LOCAL_FOLDERS, folderId)
  }

  fun saveDownloadItem(downloadItem: DownloadItem) {
    Paper.book("downloadItems").write(downloadItem.id, downloadItem)
  }

  fun removeDownloadItem(downloadItemId: String) {
    Paper.book("downloadItems").delete(downloadItemId)
  }

  fun getDownloadItems(): List<DownloadItem> {
    val downloadItems: MutableList<DownloadItem> = mutableListOf()
    Paper.book("downloadItems").allKeys.forEach { downloadItemId ->
      Paper.book("downloadItems").read<DownloadItem>(downloadItemId)?.let { downloadItems.add(it) }
    }
    return downloadItems
  }

  /**
   * Validate persisted download queue entries before restoring them.
   *
   * Queue entries can become incompatible or malformed, for example after an app update. If any
   * entry cannot be read or fails the checks required for queue restoration, the entire persisted
   * queue is cleared so startup can continue without restoring invalid data.
   *
   * @return true if the queue passes validation or was successfully cleared; false if an invalid
   * queue could not be cleared
   */
  fun ensureValidDownloadQueue(): Boolean {
    val downloadBook = Paper.book("downloadItems")
    val queueIsValid =
            try {
              downloadBook.allKeys
                      .map { downloadItemId ->
                        val item =
                                downloadBook.read<DownloadItem>(downloadItemId)
                                        ?: throw IllegalStateException(
                                                "Download queue entry $downloadItemId could not be read"
                                        )
                        if (item.id != downloadItemId) {
                          throw IllegalStateException(
                                  "Download queue entry $downloadItemId has a mismatched item ID"
                          )
                        }
                        item
                      }
                      .all { item ->
                        listOf<String?>(item.id, item.libraryItemId, item.localFolder.id).all {
                          !it.isNullOrBlank()
                        } &&
                                item.downloadItemParts.isNotEmpty() &&
                                item.downloadItemParts.all { part ->
                                  listOf<String?>(
                                                  part.id,
                                                  part.downloadItemId,
                                                  part.filename,
                                                  part.destinationPath,
                                                  part.finalDestinationPath,
                                                  part.serverPath,
                                                  part.localFolderId
                                          )
                                          .all { !it.isNullOrBlank() } &&
                                          part.downloadItemId == item.id
                                }
                      }
            } catch (readError: Exception) {
              AbsLogger.error(
                      tag,
                      "Could not read persisted download queue; clearing queue (${readError.message})"
              )
              false
            }

    if (queueIsValid) return true

    AbsLogger.error(tag, "Persisted download queue contains invalid data; clearing queue")
    return try {
      downloadBook.destroy()
      val remainingKeys = downloadBook.allKeys
      if (remainingKeys.isEmpty()) {
        AbsLogger.info(tag, "Cleared invalid persisted download queue")
        true
      } else {
        AbsLogger.error(
                tag,
                "Invalid persisted download queue still contains ${remainingKeys.size} entries after clearing"
        )
        false
      }
    } catch (clearError: Exception) {
      AbsLogger.error(
              tag,
              "Could not clear invalid persisted download queue (${clearError.message})"
      )
      false
    }
  }

  fun saveLocalMediaProgress(mediaProgress: LocalMediaProgress) {
    write(LOCAL_MEDIA_PROGRESS, mediaProgress.id, mediaProgress)
  }
  // For books this will just be the localLibraryItemId for podcast episodes this will be
  // "{localLibraryItemId}-{episodeId}"
  fun getLocalMediaProgress(localMediaProgressId: String): LocalMediaProgress? {
    return read(LOCAL_MEDIA_PROGRESS, localMediaProgressId)
  }
  fun getAllLocalMediaProgress(): List<LocalMediaProgress> {
    return readAll(LOCAL_MEDIA_PROGRESS)
  }
  fun removeLocalMediaProgress(localMediaProgressId: String) {
    PaperMigration.ensure(LOCAL_MEDIA_PROGRESS)
    Store.delete(LOCAL_MEDIA_PROGRESS, localMediaProgressId)
  }

  fun removeAllLocalMediaProgress() {
    PaperMigration.ensure(LOCAL_MEDIA_PROGRESS)
    Store.clear(LOCAL_MEDIA_PROGRESS)
  }

  fun saveMediaItemHistory(mediaItemHistory: MediaItemHistory) {
    write(MEDIA_ITEM_HISTORY, mediaItemHistory.id, mediaItemHistory)
  }
  fun getMediaItemHistory(id: String): MediaItemHistory? {
    return read(MEDIA_ITEM_HISTORY, id)
  }

  fun savePlaybackSession(playbackSession: PlaybackSession) {
    write(PLAYBACK_SESSION, playbackSession.id, playbackSession)
  }
  fun removePlaybackSession(playbackSessionId: String) {
    PaperMigration.ensure(PLAYBACK_SESSION)
    Store.delete(PLAYBACK_SESSION, playbackSessionId)
  }
  fun getPlaybackSessions(): List<PlaybackSession> {
    return readAll(PLAYBACK_SESSION)
  }

  fun saveLog(log: AbsLog) {
    write(LOG, log.id, log)
  }
  fun getAllLogs(): List<AbsLog> {
    return readAll<AbsLog>(LOG).sortedBy { it.timestamp }
  }
  fun removeAllLogs() {
    PaperMigration.ensure(LOG)
    Store.clear(LOG)
  }
}
