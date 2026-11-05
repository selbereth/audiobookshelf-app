package com.audiobookshelf.app.server

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import com.audiobookshelf.app.data.*
import com.audiobookshelf.app.core.CoreHost
import com.audiobookshelf.app.device.DeviceManager
import com.audiobookshelf.app.media.MediaEventManager
import com.audiobookshelf.app.media.MediaProgressSyncData
import com.audiobookshelf.app.media.SyncResult
import com.audiobookshelf.app.models.User
import com.audiobookshelf.app.BuildConfig
import com.audiobookshelf.app.plugins.AbsLogger
import com.audiobookshelf.app.managers.SecureStorage
import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.core.json.JsonReadFeature
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.internal.EMPTY_REQUEST
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ApiHandler(var ctx:Context) {
  val tag = "ApiHandler"

  companion object {
    // For sending data back to the Webview frontend
    lateinit var absDatabaseNotifyListeners:(String, JSObject) -> Unit

    fun checkAbsDatabaseNotifyListenersInitted():Boolean {
      return ::absDatabaseNotifyListeners.isInitialized
    }
  }

  private var pingClient = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS).build()
  private var jacksonMapper = jacksonObjectMapper().enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS.mappedFeature())

  @JsonIgnoreProperties(ignoreUnknown = true)
  data class LocalSessionSyncResult(val id:String, val success:Boolean, val progressSynced:Boolean?, val error:String?)
  data class LocalSessionsSyncResponsePayload(val results:List<LocalSessionSyncResult>)

  // The JS core makes the server calls (utils/core/modules/api.js): the authorization header, the refresh on a 401 and the retry are
  // its decisions. This class keeps its callers' signatures and answers in the shapes they always had.
  private val workers = Executors.newCachedThreadPool()

  private fun coreRequest(method: String, endpoint: String, payload: JSObject?, config: ServerConnectionConfig?, httpClient: OkHttpClient?, cb: (JSObject) -> Unit) {
    val timeoutMs = if (httpClient === pingClient) 3000L else 60000L
    val args = JSONObject()
      .put("method", method).put("endpoint", endpoint)
      .put("address", config?.address ?: DeviceManager.serverAddress)
      .put("token", config?.token ?: DeviceManager.token)
      .put("serverConnectionConfigId", config?.id ?: DeviceManager.serverConnectionConfigId)
      .put("timeoutMs", timeoutMs)
    if (payload != null) args.put("payload", JSONObject(payload.toString()))
    CoreHost.start(ctx)
    // The core answers on the main thread: hand the result to a worker, as OkHttp's callback thread was before
    CoreHost.callUp("core", "api.request", args, timeoutMs * 2 + 15000) { ok, json ->
      workers.execute {
        val result = try {
          if (ok) JSObject(json) else JSObject().put("error", "Request failed: $json")
        } catch (e: Exception) {
          JSObject().put("error", "Invalid response body")
        }
        cb(result)
      }
    }
  }

  private fun getRequest(endpoint:String, httpClient:OkHttpClient?, config:ServerConnectionConfig?, cb: (JSObject) -> Unit) =
    coreRequest("GET", endpoint, null, config, httpClient, cb)

  private fun postRequest(endpoint:String, payload: JSObject?, config:ServerConnectionConfig?, cb: (JSObject) -> Unit) =
    coreRequest("POST", endpoint, payload ?: JSObject(), config, null, cb)

  private fun patchRequest(endpoint:String, payload: JSObject, cb: (JSObject) -> Unit) =
    coreRequest("PATCH", endpoint, payload, null, null, cb)

  sealed interface RefreshResult {
    data class Success(val accessToken: String) : RefreshResult

    /** The server rejected the refresh token, so the session has already been cleared. */
    data object Rejected : RefreshResult

    /** The refresh could not be completed. Credentials are untouched and the caller may retry. */
    data object Transient : RefreshResult
  }

  /** Refreshes tokens for a specific saved server, including downloads queued while another server is active. The core does it. */
  fun refreshAuthTokens(
          serverConnectionConfigId: String,
          httpClient: OkHttpClient? = null,
          retriesLeft: Int = 2,
          onResult: (RefreshResult) -> Unit
  ) {
    CoreHost.start(ctx)
    CoreHost.callUp("core", "api.refreshAuthTokens", JSONObject().put("serverConnectionConfigId", serverConnectionConfigId), 150000) { ok, json ->
      workers.execute {
        val r = try { if (ok) JSONObject(json) else null } catch (e: Exception) { null }
        onResult(when (r?.optString("result")) {
          "success" -> RefreshResult.Success(r.optString("accessToken"))
          "rejected" -> RefreshResult.Rejected
          else -> RefreshResult.Transient
        })
      }
    }
  }

  fun getCurrentUser(cb: (User?) -> Unit) {
    getRequest("/api/me", null, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "getCurrentUser Failed")
        cb(null)
      } else {
        val user = jacksonMapper.readValue<User>(it.toString())
        cb(user)
      }
    }
  }

  fun getLibraries(cb: (List<Library>) -> Unit) {
    val mapper = jacksonMapper
    getRequest("/api/libraries?include=stats", null,null) {
      val libraries = mutableListOf<Library>()

      var array = JSONArray()
      if (it.has("libraries")) { // TODO: Server 2.2.9 changed to this
        array = it.getJSONArray("libraries")
      } else if (it.has("value")) {
        array = it.getJSONArray("value")
      }

      for (i in 0 until array.length()) {
        libraries.add(mapper.readValue(array.get(i).toString()))
      }
      cb(libraries)
    }
  }

  fun getLibraryPersonalized(libraryItemId:String, cb: (List<LibraryShelfType>?) -> Unit) {
    getRequest("/api/libraries/$libraryItemId/personalized", null, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "getLibraryStats Failed")
        cb(null)
      } else {
        val items = mutableListOf<LibraryShelfType>()
        val array = it.getJSONArray("value")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryShelfType>(array.get(i).toString())
          items.add(item)
        }
        cb(items)
      }
    }
  }

  fun getLibraryItem(libraryItemId:String, cb: (LibraryItem?) -> Unit) {
    getRequest("/api/items/$libraryItemId?expanded=1", null, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "getLibraryItem Failed")
        cb(null)
      } else {
        val libraryItem = jacksonMapper.readValue<LibraryItem>(it.toString())
        cb(libraryItem)
      }
    }
  }

  fun getLibraryItemWithProgress(libraryItemId:String, episodeId:String?, cb: (LibraryItem?) -> Unit) {
    var requestUrl = "/api/items/$libraryItemId?expanded=1&include=progress"
    if (!episodeId.isNullOrEmpty()) requestUrl += "&episode=$episodeId"
    getRequest(requestUrl, null, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "getLibraryItemWithProgress Failed")
        cb(null)
      } else {
        val libraryItem = jacksonMapper.readValue<LibraryItem>(it.toString())
        cb(libraryItem)
      }
    }
  }

  fun getLibraryItems(libraryId:String, cb: (List<LibraryItem>) -> Unit) {
    getRequest("/api/libraries/$libraryId/items?limit=100&minified=1", null, null) {
      val items = mutableListOf<LibraryItem>()
      if (it.has("results")) {
        val array = it.getJSONArray("results")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryItem>(array.get(i).toString())
          items.add(item)
        }
      }
      cb(items)
    }
  }

  fun getLibrarySeries(libraryId:String, cb: (List<LibrarySeriesItem>) -> Unit) {
    Log.d(tag, "Getting series")
    getRequest("/api/libraries/$libraryId/series?minified=1&sort=name&limit=10000", null, null) {
      val items = mutableListOf<LibrarySeriesItem>()
      if (it.has("results")) {
        val array = it.getJSONArray("results")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibrarySeriesItem>(array.get(i).toString())
          items.add(item)
        }
      }
      cb(items)
    }
  }

  fun getLibrarySeriesItems(libraryId:String, seriesId:String, cb: (List<LibraryItem>) -> Unit) {
    Log.d(tag, "Getting items for series")
    val seriesIdBase64 = Base64.encodeToString(seriesId.toByteArray(), Base64.DEFAULT)
    getRequest("/api/libraries/$libraryId/items?minified=1&sort=media.metadata.title&filter=series.${seriesIdBase64}&limit=1000", null, null) {
      val items = mutableListOf<LibraryItem>()
      if (it.has("results")) {
        val array = it.getJSONArray("results")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryItem>(array.get(i).toString())
          items.add(item)
        }
      }
      cb(items)
    }
  }

  fun getLibraryAuthors(libraryId:String, cb: (List<LibraryAuthorItem>) -> Unit) {
    Log.d(tag, "Getting series")
    getRequest("/api/libraries/$libraryId/authors", null, null) {
      val items = mutableListOf<LibraryAuthorItem>()
      if (it.has("authors")) {
        val array = it.getJSONArray("authors")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryAuthorItem>(array.get(i).toString())
          items.add(item)
        }
      }else{
        Log.e(tag, "No results")
      }
      cb(items)
    }
  }

  fun getLibraryItemsFromAuthor(libraryId:String, authorId:String, cb: (List<LibraryItem>) -> Unit) {
    Log.d(tag, "Getting author items")
    val authorIdBase64 = Base64.encodeToString(authorId.toByteArray(), Base64.DEFAULT)
    getRequest("/api/libraries/$libraryId/items?limit=1000&minified=1&filter=authors.${authorIdBase64}&sort=media.metadata.title&collapseseries=1", null, null) {
      val items = mutableListOf<LibraryItem>()
      if (it.has("results")) {
        val array = it.getJSONArray("results")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryItem>(array.get(i).toString())
          if (item.collapsedSeries != null) {
            item.collapsedSeries?.libraryId = libraryId
          }
          items.add(item)
        }
      }else{
        Log.e(tag, "No results")
      }
      cb(items)
    }
  }

  fun getLibraryCollections(libraryId:String, cb: (List<LibraryCollection>) -> Unit) {
    Log.d(tag, "Getting collections")
    getRequest("/api/libraries/$libraryId/collections?minified=1&sort=name&limit=1000", null, null) {
      val items = mutableListOf<LibraryCollection>()
      if (it.has("results")) {
        val array = it.getJSONArray("results")
        for (i in 0 until array.length()) {
          val item = jacksonMapper.readValue<LibraryCollection>(array.get(i).toString())
          items.add(item)
        }
      }
      cb(items)
    }
  }

  fun getSearchResults(libraryId:String, queryString:String, cb: (LibraryItemSearchResultType?) -> Unit) {
    Log.d(tag, "Doing search for library $libraryId")
    getRequest("/api/libraries/$libraryId/search?q=$queryString", null, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "getSearchResults Failed")
        cb(null)
      } else {
        val librarySearchResults = jacksonMapper.readValue<LibraryItemSearchResultType>(it.toString())
        cb(librarySearchResults)
      }
    }
  }

  fun getAllItemsInProgress(cb: (List<ItemInProgress>) -> Unit) {
    getRequest("/api/me/items-in-progress", null, null) {
      val items = mutableListOf<ItemInProgress>()
      if (it.has("libraryItems")) {
        val array = it.getJSONArray("libraryItems")
        for (i in 0 until array.length()) {
          val jsobj = array.get(i) as JSONObject
          val itemInProgress = ItemInProgress.makeFromServerObject(jsobj, jacksonMapper)
          items.add(itemInProgress)
        }
      }
      cb(items)
    }
  }

  fun playLibraryItem(libraryItemId:String, episodeId:String?, playItemRequestPayload:PlayItemRequestPayload, cb: (PlaybackSession?) -> Unit) {
    val payload = JSObject(jacksonMapper.writeValueAsString(playItemRequestPayload))

    val endpoint = if (episodeId.isNullOrEmpty()) "/api/items/$libraryItemId/play" else "/api/items/$libraryItemId/play/$episodeId"
    postRequest(endpoint, payload, null) {
      if (it.has("error")) {
        Log.e(tag, it.getString("error") ?: "Play Library Item Failed")
        cb(null)
      } else {
        it.put("serverConnectionConfigId", DeviceManager.serverConnectionConfig?.id)
        it.put("serverAddress", DeviceManager.serverAddress)
        val playbackSession = jacksonMapper.readValue<PlaybackSession>(it.toString())
        cb(playbackSession)
      }
    }
  }

  fun sendProgressSync(sessionId:String, syncData: MediaProgressSyncData, cb: (Boolean, String?) -> Unit) {
    val payload = JSObject(jacksonMapper.writeValueAsString(syncData))

    postRequest("/api/session/$sessionId/sync", payload, null) {
      if (!it.getString("error").isNullOrEmpty()) {
        cb(false, it.getString("error"))
      } else {
        cb(true, null)
      }
    }
  }

  private fun createPartialPlaybackSession(playbackSession: PlaybackSession): ObjectNode {
    val json = jacksonMapper.createObjectNode()
    json.put("id", playbackSession.id)
    json.put("userId", playbackSession.userId)
    json.put("libraryItemId", playbackSession.libraryItemId)
    json.put("episodeId", playbackSession.episodeId)
    json.put("mediaType", playbackSession.mediaType)
    json.put("displayTitle", playbackSession.displayTitle)
    json.put("displayAuthor", playbackSession.displayAuthor)
    json.put("duration", playbackSession.duration)
    json.put("playMethod", playbackSession.playMethod)
    json.put("startedAt", playbackSession.startedAt)
    json.put("updatedAt", playbackSession.updatedAt)
    json.put("timeListening", playbackSession.timeListening)
    json.put("currentTime", playbackSession.currentTime)
    json.put("mediaPlayer", playbackSession.mediaPlayer)
    return json
  }

  fun sendLocalProgressSync(playbackSession:PlaybackSession, cb: (Boolean, String?) -> Unit) {
    val partialSession = createPartialPlaybackSession(playbackSession)
    partialSession.set<ObjectNode>("deviceInfo", jacksonMapper.valueToTree(playbackSession.deviceInfo))
    postRequest("/api/session/local", JSObject(partialSession.toString()), null) {
      if (!it.getString("error").isNullOrEmpty()) {
        cb(false, it.getString("error"))
      } else {
        cb(true, null)
      }
    }
  }

  fun updateMediaProgress(libraryItemId:String,episodeId:String?,updatePayload:JSObject, cb: () -> Unit) {
    Log.d(tag, "updateMediaProgress $libraryItemId $episodeId $updatePayload")
    val endpoint = if(episodeId.isNullOrEmpty()) "/api/me/progress/$libraryItemId" else "/api/me/progress/$libraryItemId/$episodeId"
    patchRequest(endpoint,updatePayload) {
      Log.d(tag, "updateMediaProgress patched progress")
      cb()
    }
  }

  fun getMediaProgress(libraryItemId:String, episodeId:String?, serverConnectionConfig:ServerConnectionConfig?, cb: (MediaProgress?) -> Unit) {
    val endpoint = if(episodeId.isNullOrEmpty()) "/api/me/progress/$libraryItemId" else "/api/me/progress/$libraryItemId/$episodeId"

    // TODO: Using ping client here allows for shorter timeout (3 seconds), maybe rename or make diff client for requests requiring quicker response
    getRequest(endpoint, pingClient, serverConnectionConfig) {
      if (it.has("error")) {
        Log.e(tag, "getMediaProgress: Failed to get progress")
        cb(null)
      } else {
        val progress = jacksonMapper.readValue<MediaProgress>(it.toString())
        cb(progress)
      }
    }
  }

  fun getPlaybackSession(playbackSessionId:String, cb: (PlaybackSession?) -> Unit) {
    Log.d(tag, "getPlaybackSession for $playbackSessionId for server ${DeviceManager.serverAddress}")
    val endpoint = "/api/session/$playbackSessionId"
    getRequest(endpoint, null, null) {
      val err = it.getString("error")
      if (!err.isNullOrEmpty()) {
        cb(null)
      } else {
        cb(jacksonMapper.readValue<PlaybackSession>(it.toString()))
      }
    }
  }

  fun pingServer(config:ServerConnectionConfig, cb: (Boolean) -> Unit) {
    Log.d(tag, "pingServer: Pinging ${config.address}")
    getRequest("/ping", pingClient, config) {
      val success = it.getString("success")
      if (success.isNullOrEmpty()) {
        Log.d(tag, "pingServer: Ping ${config.address} Failed")
        cb(false)
      } else {
        Log.d(tag, "pingServer: Ping ${config.address} Successful")
        cb(true)
      }
    }
  }

  fun closePlaybackSession(playbackSessionId:String, config:ServerConnectionConfig?, cb: (Boolean) -> Unit) {
    Log.d(tag, "closePlaybackSession: playbackSessionId=$playbackSessionId")
    postRequest("/api/session/$playbackSessionId/close", null, config) {
      cb(true)
    }
  }

  fun authorize(config:ServerConnectionConfig, cb: (MutableList<MediaProgress>?) -> Unit) {
    Log.d(tag, "authorize: Authorizing ${config.address}")
    postRequest("/api/authorize", JSObject(), config) {
      val error = it.getString("error")
      if (!error.isNullOrEmpty()) {
        Log.d(tag, "authorize: Authorize ${config.address} Failed: $error")
        cb(null)
      } else {
        val mediaProgressList:MutableList<MediaProgress> = mutableListOf()
        val user = it.getJSObject("user")
        val mediaProgress = user?.getJSONArray("mediaProgress") ?: JSONArray()
        for (i in 0 until mediaProgress.length()) {
          val mediaProg = jacksonMapper.readValue<MediaProgress>(mediaProgress.getJSONObject(i).toString())
          mediaProgressList.add(mediaProg)
        }
        Log.d(tag, "authorize: Authorize ${config.address} Successful")
        cb(mediaProgressList)
      }
    }
  }
}
