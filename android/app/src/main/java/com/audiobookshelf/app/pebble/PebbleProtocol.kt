package com.audiobookshelf.app.pebble

import java.util.UUID

/**
 * The messages between the Pebble watchapp (`pebble/` in the repository) and this app.
 * The numbers must match `messageKeys` and the command and state values in `pebble/package.json` and `pebble/src/c/main.c`.
 */
object PebbleProtocol {
  val WATCHAPP_UUID: UUID = UUID.fromString("481B78C4-0301-4950-AF0B-DD24992F6602")

  // Message keys
  const val KEY_COMMAND = 0u // watch to phone (UInt8)
  const val KEY_STATE = 1u // phone to watch (UInt8)
  const val KEY_TITLE = 2u // phone to watch (text): the book
  const val KEY_CHAPTER = 3u // phone to watch (text): the chapter being played
  const val KEY_POSITION = 4u // phone to watch (UInt32): seconds into the book
  const val KEY_DURATION = 5u // phone to watch (UInt32): length of the book in seconds
  const val KEY_CHAPTER_NUMBER = 6u // phone to watch (UInt16): 1 based, 0 when the book has no chapters
  const val KEY_CHAPTER_COUNT = 7u // phone to watch (UInt16)
  const val KEY_CHAPTER_POSITION = 10u // phone to watch (UInt32): how far into the chapter, same units as KEY_POSITION
  const val KEY_CHAPTER_DURATION = 11u // phone to watch (UInt32): length of the chapter, same units as KEY_DURATION (0 = unknown)
  const val KEY_KIND = 9u // phone to watch (UInt8): KIND_AUDIO or KIND_EPUB
  const val KEY_VOLUME = 8u // phone to watch (UInt8): media volume step; the watch vibrates when it changes after a volume press

  const val KIND_AUDIO = 0 // an audiobook: position and duration are seconds
  const val KIND_EPUB = 1 // EPUB read aloud: position is the percentage in hundredths, duration is 10000

  // Commands from the watch
  const val CMD_HELLO = 0 // the watchapp was opened: tell it what is playing
  const val CMD_PLAY_PAUSE = 1 // play or pause; with nothing loaded, start the book played most recently
  const val CMD_SKIP_FORWARD = 2
  const val CMD_SKIP_BACK = 3
  const val CMD_VOLUME_UP = 4 // a long press of Up on the watch, repeated while it is held
  const val CMD_VOLUME_DOWN = 5 // a long press of Down

  // What the phone tells the watch
  const val STATE_NOTHING_TO_PLAY = 0 // no book has been played on this phone yet
  const val STATE_PAUSED = 1 // paused, or ready to start the most recent book
  const val STATE_PLAYING = 2
  const val STATE_LOADING = 3 // the book is being started
  const val STATE_ERROR = 4 // could not start: the title shows what to do

  /** Pebble messages are small: keep the title short enough for the watch screen */
  const val MAX_TITLE_LENGTH = 60
}
