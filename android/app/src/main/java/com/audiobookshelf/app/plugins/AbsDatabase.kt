package com.audiobookshelf.app.plugins

import android.util.Log
import com.audiobookshelf.app.MainActivity
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.server.ApiHandler
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * What is left of the database plugin. Everything that only touches the data (device data, server connections, local items, folders,
 * progress, history, settings) is in the core now (utils/core/modules/db.js, called from the UI as AbsDatabase.* through
 * plugins/capacitor/AbsDatabase.js). These two also call the server, so they stay until the API moves to the core (Phase 3).
 */
@CapacitorPlugin(name = "AbsDatabase")
class AbsDatabase : Plugin() {
  val tag = "AbsDatabase"
  private var jacksonMapper = jacksonObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())

  private lateinit var mainActivity: MainActivity
  private lateinit var apiHandler: ApiHandler

  override fun load() {
    mainActivity = (activity as MainActivity)
    apiHandler = ApiHandler(mainActivity)
    ApiHandler.absDatabaseNotifyListeners = ::notifyListeners
  }

  @PluginMethod
  fun syncLocalSessionsWithServer(call:PluginCall) {
    if (DeviceManager.serverConnectionConfig == null) {
      AbsLogger.error("AbsDatabase", "syncLocalSessionsWithServer: not connected to server")
      return call.resolve()
    }

    apiHandler.syncLocalMediaProgressForUser {
      val savedSessions = DeviceManager.dbManager.getPlaybackSessions().filter { it.serverConnectionConfigId == DeviceManager.serverConnectionConfigId }

      if (savedSessions.isNotEmpty()) {
        apiHandler.sendSyncLocalSessions(savedSessions) { success, errorMsg ->
          if (!success) {
            call.resolve(JSObject("{\"error\":\"$errorMsg\"}"))
          } else {
            AbsLogger.info("AbsDatabase", "syncLocalSessionsWithServer: Finished sending local playback sessions to server. Removing ${savedSessions.size} saved sessions.")
            // Remove all local sessions
            savedSessions.forEach {
              DeviceManager.dbManager.removePlaybackSession(it.id)
            }
            call.resolve()
          }
        }
      } else {
        AbsLogger.info("AbsDatabase", "syncLocalSessionsWithServer: No saved local playback sessions to send to server.")
        call.resolve()
      }
    }
  }

  // Updates received via web socket
  // This function doesn't need to sync with the server also because this data is coming from the server
  // If sending the localMediaProgressId then update existing media progress
  // If sending localLibraryItemId then save new local media progress
  @PluginMethod
  fun updateLocalMediaProgressFinished(call:PluginCall) {
    val localLibraryItemId = call.getString("localLibraryItemId", "").toString()
    var localEpisodeId:String? = call.getString("localEpisodeId", "").toString()
    if (localEpisodeId.isNullOrEmpty()) localEpisodeId = null

    val localMediaProgressId = if (localEpisodeId.isNullOrEmpty()) localLibraryItemId else "$localLibraryItemId-$localEpisodeId"
    val isFinished = call.getBoolean("isFinished", false) == true

    Log.d(tag, "updateLocalMediaProgressFinished $localMediaProgressId | Is Finished:$isFinished")
    var localMediaProgress = DeviceManager.dbManager.getLocalMediaProgress(localMediaProgressId)

    if (localMediaProgress == null) { // Create new local media progress if does not exist
     Log.d(tag, "updateLocalMediaProgressFinished Local Media Progress not found $localMediaProgressId - Creating new")
      val localLibraryItem = DeviceManager.dbManager.getLocalLibraryItem(localLibraryItemId)

      if (localLibraryItem == null) {
        return call.resolve(JSObject("{\"error\":\"Library Item not found\"}"))
      }
      if (localLibraryItem.mediaType != "podcast" && !localEpisodeId.isNullOrEmpty()) {
        return call.resolve(JSObject("{\"error\":\"Invalid library item not a podcast\"}"))
      }

      val duration: Double
      var podcastEpisode: PodcastEpisode? = null
      if (!localEpisodeId.isNullOrEmpty()) {
          val podcast = localLibraryItem.media as Podcast
        podcastEpisode = podcast.episodes?.find { episode ->
            episode.id == localEpisodeId
          }
        if (podcastEpisode == null) {
          return call.resolve(JSObject("{\"error\":\"Podcast episode not found\"}"))
        }
        duration = podcastEpisode.duration ?: 0.0
      } else {
        val book = localLibraryItem.media as Book
        duration = book.duration ?: 0.0
      }

      val currentTime = System.currentTimeMillis()
      localMediaProgress = LocalMediaProgress(
        id = localMediaProgressId,
        localLibraryItemId = localLibraryItemId,
        localEpisodeId = localEpisodeId,
        duration = duration,
        progress = if (isFinished) 1.0 else 0.0,
        currentTime = 0.0,
        isFinished = isFinished,
        ebookLocation = null,
        ebookProgress = null,
        lastUpdate = currentTime,
        startedAt = if (isFinished) currentTime else 0L,
        finishedAt = if (isFinished) currentTime else null,
        serverConnectionConfigId = localLibraryItem.serverConnectionConfigId,
        serverAddress = localLibraryItem.serverAddress,
        serverUserId = localLibraryItem.serverUserId,
        libraryItemId = localLibraryItem.libraryItemId,
        episodeId = podcastEpisode?.serverEpisodeId)
    } else {
      localMediaProgress.updateIsFinished(isFinished)
    }

    // Save local media progress locally
    DeviceManager.dbManager.saveLocalMediaProgress(localMediaProgress)

    val lmpstring = jacksonMapper.writeValueAsString(localMediaProgress)
    Log.d(tag, "updateLocalMediaProgressFinished: Local Media Progress String $lmpstring")

    // Send update to server media progress is linked to a server and user is logged into that server
    localMediaProgress.serverConnectionConfigId?.let { configId ->
      if (DeviceManager.serverConnectionConfigId == configId) {
        val libraryItemId = localMediaProgress.libraryItemId ?: ""
        val episodeId = localMediaProgress.episodeId ?: ""
        val updatePayload = JSObject()
        updatePayload.put("isFinished", isFinished)
        apiHandler.updateMediaProgress(libraryItemId,episodeId,updatePayload) {
          Log.d(tag, "updateLocalMediaProgressFinished: Updated media progress isFinished on server")
          val jsobj = JSObject()
          jsobj.put("local", true)
          jsobj.put("server", true)
          jsobj.put("localMediaProgress", JSObject(lmpstring))
          call.resolve(jsobj)
        }
      }
    }
    if (localMediaProgress.serverConnectionConfigId == null || DeviceManager.serverConnectionConfigId != localMediaProgress.serverConnectionConfigId) {
      val jsobj = JSObject()
      jsobj.put("local", true)
      jsobj.put("server", false)
      jsobj.put("localMediaProgress", JSObject(lmpstring))
      call.resolve(jsobj)
    }
  }

}
