package com.audiobookshelf.app.pebble

import java.util.UUID

/**
 * The watchapp's identity. What the messages mean (keys, commands, states) is in `utils/pebble/protocol.js`, shared with iOS:
 * native code only moves them.
 */
object PebbleProtocol {
  val WATCHAPP_UUID: UUID = UUID.fromString("481B78C4-0301-4950-AF0B-DD24992F6602")
}
