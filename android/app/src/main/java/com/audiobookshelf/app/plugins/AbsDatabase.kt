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

}
