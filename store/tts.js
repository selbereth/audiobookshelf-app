/** State of the EPUB read-aloud session. The session logic lives in `utils/tts/ttsSession.js` */
export const state = () => ({
  active: false,
  playing: false,
  /** Shown again after the app was reopened: nothing is loaded until play is pressed */
  restored: false,
  rate: 1,
  libraryItemId: null,
  /** The same book can be open as the downloaded copy or the server's: either id identifies this session */
  serverLibraryItemId: null,
  localLibraryItemId: null,
  libraryItem: null,
  localLibraryItem: null,
  title: '',
  author: '',
  progress: 0, // 0-100, whole book
  /** Where the current chapter starts and ends in the book, 0-100 (both 0 when unknown) */
  chapterStart: 0,
  chapterEnd: 0,
  /** Table of contents entries that map to a spine item: {id, title, spine, href} */
  chapters: [],
  currentChapterIndex: -1,
  sleepRunning: false,
  sleepAtChapterEnd: false,
  sleepRemaining: 0 // seconds
})

export const getters = {
  currentChapter: (state) => state.chapters[state.currentChapterIndex] || null,
  nextChapter: (state) => state.chapters[state.currentChapterIndex + 1] || null
}

export const mutations = {
  setSession(state, session) {
    state.active = true
    state.playing = false
    state.restored = false
    state.libraryItemId = session.libraryItemId
    state.serverLibraryItemId = session.serverLibraryItemId || null
    state.localLibraryItemId = session.localLibraryItemId || null
    state.libraryItem = session.libraryItem
    state.localLibraryItem = session.localLibraryItem
    state.title = session.title
    state.author = session.author
    state.progress = session.progress || 0
    state.chapters = session.chapters || []
    state.currentChapterIndex = -1
    state.chapterStart = 0
    state.chapterEnd = 0
    state.sleepRunning = false
    state.sleepAtChapterEnd = false
    state.sleepRemaining = 0
  },
  /** The last session, remembered across an app restart */
  setRestoredSession(state, session) {
    state.active = true
    state.playing = false
    state.restored = true
    state.libraryItemId = session.libraryItemId
    state.serverLibraryItemId = session.serverLibraryItemId || null
    state.localLibraryItemId = session.localLibraryItemId || null
    state.libraryItem = session.libraryItem
    state.localLibraryItem = session.localLibraryItem
    state.title = session.title
    state.author = session.author
    state.progress = session.progress || 0
    state.chapters = []
    state.currentChapterIndex = -1
    state.chapterStart = 0
    state.chapterEnd = 0
  },
  clear(state) {
    state.active = false
    state.restored = false
    state.playing = false
    state.libraryItemId = null
    state.serverLibraryItemId = null
    state.localLibraryItemId = null
    state.libraryItem = null
    state.localLibraryItem = null
    state.chapters = []
    state.currentChapterIndex = -1
    state.sleepRunning = false
    state.sleepAtChapterEnd = false
    state.sleepRemaining = 0
  },
  setPlaying(state, val) {
    state.playing = !!val
  },
  setRate(state, val) {
    state.rate = val
  },
  setProgress(state, val) {
    state.progress = val
  },
  setCurrentChapterIndex(state, val) {
    state.currentChapterIndex = val
  },
  setChapterRange(state, { start, end }) {
    state.chapterStart = start
    state.chapterEnd = end
  },
  setSleep(state, { running, atChapterEnd, remaining }) {
    state.sleepRunning = !!running
    state.sleepAtChapterEnd = !!atChapterEnd
    state.sleepRemaining = remaining || 0
  }
}
