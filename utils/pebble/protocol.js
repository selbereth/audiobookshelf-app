/**
 * The messages between the Pebble watchapp (the separate repo `selbershelf-pebble`, `src/c/main.c`) and the phone. The numbers
 * must match `messageKeys` in the watchapp's package.json and the `#define`s in its main.c. Native code only moves messages:
 * it never needs to know what a key means.
 */

export const WATCHAPP_UUID = '481b78c4-0301-4950-af0b-dd24992f6602'

/** Message keys. `type` says how native code writes the value into the watch's message */
export const KEY = {
  Command: { id: 0, type: 'u8' }, // watch to phone
  State: { id: 1, type: 'u8' },
  Title: { id: 2, type: 'text' },
  Chapter: { id: 3, type: 'text' },
  Position: { id: 4, type: 'u32' },
  Duration: { id: 5, type: 'u32' },
  ChapterNumber: { id: 6, type: 'u16' },
  ChapterCount: { id: 7, type: 'u16' },
  Volume: { id: 8, type: 'u8' },
  Kind: { id: 9, type: 'u8' },
  ChapterPosition: { id: 10, type: 'u32' },
  ChapterDuration: { id: 11, type: 'u32' },
  Speed: { id: 12, type: 'u16' }, // hundredths: 120 = 1.2x
  List: { id: 13, type: 'text' }, // the labels of a page of a list, one per line
  ListLevel: { id: 14, type: 'u8' },
  ListTotal: { id: 15, type: 'u8' },
  ListStart: { id: 16, type: 'u8' },
  ArgShelf: { id: 17, type: 'u8' }, // watch to phone
  ArgItem: { id: 18, type: 'u8' },
  ArgFormat: { id: 19, type: 'u8' }
}

export const CMD = {
  HELLO: 0, // the watchapp was opened: tell it what is playing
  PLAY_PAUSE: 1, // with nothing loaded, start the book played most recently
  SKIP_FORWARD: 2,
  SKIP_BACK: 3,
  VOLUME_UP: 4,
  VOLUME_DOWN: 5,
  SPEED_UP: 6,
  SPEED_DOWN: 7,
  BROWSE: 8, // a page of a list: ListLevel, ArgShelf (books) and ArgItem (first row wanted)
  START_BOOK: 9 // ArgShelf, ArgItem, ArgFormat: start it, or answer with the formats to pick from
}

export const STATE = { NOTHING_TO_PLAY: 0, PAUSED: 1, PLAYING: 2, LOADING: 3, ERROR: 4 }

export const KIND = { AUDIO: 0, EPUB: 1 }

export const LEVEL = { SHELVES: 0, BOOKS: 1, FORMATS: 2 }

export const FORMAT_ASK = 255 // start it if there is only one way to, otherwise send the formats

/** The watch's inbox is small: this many labels per message, this many characters each */
export const LIST_PAGE_SIZE = 5
export const MAX_LIST_ROWS = 30
export const MAX_LABEL_LENGTH = 34
export const MAX_TITLE_LENGTH = 60

export const MIN_SPEED = 0.5
/** Read aloud (the speech engine) can go much slower than the audiobook player */
export const MIN_TTS_SPEED = 0.1
export const MAX_SPEED = 3.0
