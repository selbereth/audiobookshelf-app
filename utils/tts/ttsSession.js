import ePub from 'epubjs'
import { AbsTts, AbsAudioPlayer } from '@/plugins/capacitor'
import { sentenceStream, earlierSections } from './sentenceStream'
import { ChunkSender } from './chunkSender'
import { saveEbookProgress } from '../ebookProgress'

const SAVE_PROGRESS_INTERVAL = 15000
const PERSIST_INTERVAL = 2000
const RATE_STORAGE_KEY = 'ttsRate'
/** The last read-aloud session, so the app can show it (paused) after being closed */
const LAST_SESSION_KEY = 'ttsLastSession'

/** Only what the player needs to show the book and reopen it */
const trimLibraryItem = (item) =>
  item && {
    id: item.id,
    libraryId: item.libraryId,
    mediaType: item.mediaType,
    updatedAt: item.updatedAt,
    media: { coverPath: item.media?.coverPath, metadata: { title: item.media?.metadata?.title, authorName: item.media?.metadata?.authorName } }
  }
const trimLocalLibraryItem = (item) => item && { id: item.id, libraryItemId: item.libraryItemId, coverContentUrl: item.coverContentUrl }

/**
 * The read-aloud session. It is global so playback continues after the EPUB reader is closed:
 * it owns the epub.js Book that produces the text and listens to the native AbsTts events.
 * The reader attaches handlers (highlight / follow along) while it is open.
 */
class TtsSession {
  constructor() {
    this.store = null
    this.book = null
    this.sender = null
    this.streamId = 0
    this.nativeListeners = []
    this.sentenceHandlers = new Set()
    this.lastSavedAt = 0
    this.currentCfi = null
    /** Every sentence sent to native, in reading order, without its text: lets a seek find its place without parsing the book again */
    this.index = []
    this.sleepEndsAt = 0
    this.sleepInterval = null
    /** What the session needs to reopen the book and save progress. See `start` */
    this.meta = null
    this.lastPersistedAt = 0
    /** The session was handed the reader's own Book: the reader destroys it when it is still open at the end */
    this.bookFromReader = false
    /** start()/resume() is running: ignore a second tap */
    this.starting = false
  }

  get active() {
    return !!this.store?.state.tts.active
  }

  get libraryItemId() {
    return this.store?.state.tts.libraryItemId
  }

  /**
   * @param {import('vuex').Store} store
   * @param {object} toast
   * @param {object} app the root Vue instance, for $axios, $db and $nativeHttp
   */
  init(store, toast, app) {
    this.store = store
    this.toast = toast
    this.app = app
    this.strings = app?.$strings || {}
    try {
      const rate = Number(localStorage.getItem(RATE_STORAGE_KEY))
      if (rate > 0) store.commit('tts/setRate', rate)
    } catch (error) {
      // localStorage can be unavailable
    }
  }

  /** Translated text, falling back to the key */
  str(key) {
    return this.strings?.[key] || key
  }

  /** Where the notification gets the cover from: the downloaded copy's, or the server's (a placeholder is not a cover) */
  coverUriFor(meta) {
    const local = meta.localLibraryItem?.coverContentUrl
    if (local) return local
    const id = meta.serverLibraryItemId || meta.libraryItem?.id
    const url = id ? this.store.getters['globals/getLibraryItemCoverSrcById'](id, 'placeholder') : null
    return url && url.startsWith('http') ? url : ''
  }

  /** Table of contents entries that point into the spine, in reading order */
  buildChapters(book) {
    const chapters = []
    const seen = new Set()
    const walk = (items) => {
      for (const item of items || []) {
        const href = String(item.href || '').split('#')[0]
        const section = href ? book.spine.get(href) : null
        if (section && !seen.has(section.index)) {
          seen.add(section.index)
          chapters.push({ id: item.id || href, title: String(item.label || '').trim() || href, spine: section.index, href })
        }
        walk(item.subitems)
      }
    }
    walk(book.navigation?.toc)
    return chapters.sort((a, b) => a.spine - b.spine)
  }

  /** The stream of sentences is produced for the native queue. `startAtSpine` begins at a chapter start. */
  createSender({ startCfi = null, startSpine = 0, startAtSpine = false }) {
    this.sender?.cancel()
    this.streamId++
    const signal = { cancelled: false }
    const historyCfis = new Set()
    const sender = new ChunkSender({
      stream: sentenceStream(this.book, { startSpine, startCfi, startAtSpine, historyCfis, signal }),
      streamId: this.streamId,
      send: (chunk) => this.sendChunk(chunk),
      onError: () => this.toast?.error(this.str('MessageTtsFailedToReadBook'))
    })
    const cancel = sender.cancel.bind(sender)
    sender.cancel = () => {
      signal.cancelled = true
      cancel()
    }
    sender.signal = signal
    sender.position = { startCfi: startAtSpine ? null : startCfi, startSpine }
    sender.historyCfis = historyCfis
    this.sender = sender
    this.index = []
    // Every section from here on is buffered whole once the forward stream has passed it. The start section
    // is only whole from its start position, its earlier part arrives with the earlier sections.
    this.fullFrom = startCfi && !startAtSpine ? startSpine + 1 : startSpine
    return sender
  }

  /** Sends a chunk to native and remembers where each of its sentences is */
  sendChunk(chunk) {
    if (chunk.streamId === this.streamId) {
      for (const sentence of chunk.sentences) this.index.push({ id: sentence.id, cfi: sentence.cfi, spine: sentence.spine })
    }
    return AbsTts.appendChunk(chunk)
  }

  /**
   * Produces the text going forward (eagerly, so the native queue has the whole rest of the book) and then,
   * so the listener can rewind to the very start of the book, everything before the history window.
   */
  async runSender(sender) {
    await sender.run()
    if (sender.cancelled) return
    const { streamId, signal, historyCfis } = sender
    try {
      for await (const block of earlierSections(this.book, { ...sender.position, historyCfis, signal })) {
        if (signal.cancelled || streamId !== this.streamId) return
        if (streamId !== this.streamId) return
        if (block.sentences.length) {
          this.index = block.sentences.map((x) => ({ id: x.id, cfi: x.cfi, spine: x.spine })).concat(this.index)
          await AbsTts.prependChunk({ streamId, sentences: block.sentences })
        }
        this.fullFrom = block.spine
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } catch (error) {
      console.error('[TtsSession] failed to read earlier sections', error)
    }
  }

  /** Jump to somewhere that is not in the native queue: restart the stream there */
  async restartAt(position) {
    if (!this.active || !this.book) return
    this.sentencesIntoChapter = 0
    const sender = this.createSender(position)
    await AbsTts.reset({ streamId: this.streamId })
    this.runSender(sender)
  }

  /** Is every sentence of this section already in the native queue? */
  isBuffered(spine) {
    if (spine < this.fullFrom || !this.index.length) return false
    const last = this.index[this.index.length - 1]
    // Either the forward stream has moved on to a later section or it has sent the whole book
    return last.spine > spine || (this.sender?.done && last.spine >= spine)
  }

  /** Index of the first buffered sentence for which `isAtOrAfter(entry)` is true (binary search: the index is in reading order) */
  findInBuffer(isAtOrAfter) {
    let lo = 0
    let hi = this.index.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (isAtOrAfter(this.index[mid])) hi = mid
      else lo = mid + 1
    }
    return lo < this.index.length ? this.index[lo] : null
  }

  /** Jump to text that native already has: no need to read the book again. Returns false when it is not buffered. */
  async seekInBuffer({ spine, cfi }) {
    if (!this.isBuffered(spine)) return false
    const compare = cfi ? new ePub.CFI() : null
    const target = this.findInBuffer(cfi ? (entry) => entry.spine > spine || (entry.spine === spine && compare.compare(entry.cfi, cfi) >= 0) : (entry) => entry.spine >= spine)
    if (!target || (!cfi && target.spine !== spine)) return false
    const result = await AbsTts.seekToSentence({ id: target.id })
    return !!result?.found
  }

  /**
   * Read aloud is running (or paused) for this book and the reader wants it to read from `cfi` (the top of the page they are
   * looking at): move there and play. Not a new session: text the native queue already has is used as it is.
   */
  async readFrom(cfi) {
    if (!this.active || this.store.state.tts.restored || !this.book || !cfi) return
    const spine = this.book.spine.get(cfi)?.index ?? 0
    if (!(await this.seekInBuffer({ spine, cfi }))) await this.restartAt({ startCfi: cfi, startSpine: spine })
    if (!this.store.state.tts.playing) await AbsTts.play()
  }

  async jumpToChapter(chapter) {
    if (!chapter) return
    if (await this.seekInBuffer({ spine: chapter.spine })) return
    await this.restartAt({ startSpine: chapter.spine, startAtSpine: true })
  }

  /** @param {number} direction 1 = next chapter, -1 = start of this chapter (or the previous one when already near the start) */
  async skipChapter(direction) {
    const { chapters, currentChapterIndex } = this.store.state.tts
    if (!chapters.length) return
    if (direction > 0) return this.jumpToChapter(chapters[currentChapterIndex + 1])
    const current = chapters[currentChapterIndex]
    // Already into this chapter: go to its start. Otherwise the previous chapter.
    if (current && this.sentencesIntoChapter > 3) return this.jumpToChapter(current)
    return this.jumpToChapter(chapters[Math.max(currentChapterIndex - 1, 0)] || current)
  }

  /** @param {number} percent 0-100 */
  async seekToPercent(percent) {
    const locations = this.book?.locations
    if (!locations?.length()) return
    const cfi = locations.cfiFromPercentage(Math.min(Math.max(percent, 0), 100) / 100)
    const startSpine = this.book.spine.get(cfi)?.index || 0
    if (await this.seekInBuffer({ spine: startSpine, cfi })) return
    await this.restartAt({ startCfi: cfi, startSpine })
  }

  setRate(rate) {
    this.store.commit('tts/setRate', rate)
    try {
      localStorage.setItem(RATE_STORAGE_KEY, String(rate))
    } catch (error) {
      // localStorage can be unavailable
    }
    AbsTts.setRate({ rate })
  }

  // --- Sleep timer: native does the work (so it fires with the screen off), this only mirrors it for the UI ---
  async setSleepTimer({ ms, isChapterTime }) {
    if (this.store.state.tts.restored) return this.toast?.info(this.str('MessageTtsPressPlayFirst'))
    if (!isChapterTime) return AbsTts.setSleepTimer({ ms })
    // Pause where the next chapter of the table of contents starts (or at the end of the book)
    const { chapters, currentChapterIndex } = this.store.state.tts
    const next = chapters[currentChapterIndex + 1]
    await AbsTts.setSleepTimer({ endOfChapter: true, untilSpine: next ? next.spine : Number.MAX_SAFE_INTEGER })
  }

  adjustSleepTimer(ms) {
    return AbsTts.adjustSleepTimer({ ms })
  }

  cancelSleepTimer() {
    return AbsTts.cancelSleepTimer()
  }

  onSleepTimer({ remainingMs, running, atChapterEnd }) {
    clearInterval(this.sleepInterval)
    this.sleepEndsAt = running && !atChapterEnd ? Date.now() + remainingMs : 0
    const update = () => {
      const remaining = this.sleepEndsAt ? Math.max(0, Math.round((this.sleepEndsAt - Date.now()) / 1000)) : 0
      this.store.commit('tts/setSleep', { running, atChapterEnd, remaining })
    }
    update()
    if (this.sleepEndsAt) this.sleepInterval = setInterval(update, 1000)
  }

  /**
   * @param {object} params
   * @param {ePub.Book} params.book - ownership passes to the session, it is destroyed when the session stops
   * @param {string} params.startCfi
   * @param {boolean} [params.bookFromReader] the book is the open reader's, not one the session opened itself
   * @param {object} params.meta
   * @param {object} params.meta.libraryItem
   * @param {object|null} params.meta.localLibraryItem
   * @param {string} params.meta.url where the epub file is
   * @param {boolean} params.meta.isLocal
   * @param {string|null} params.meta.serverLibraryItemId item to save progress to on the server
   * @param {string|null} params.meta.localLibraryItemId item to save progress to on the device
   * @param {boolean} params.meta.keepProgress
   * @param {number} [params.meta.progress] 0-100
   */
  async start({ book, startCfi, meta, bookFromReader = false }) {
    if (this.starting) return
    this.starting = true
    try {
      await this.startSession({ book, startCfi, meta, bookFromReader })
    } catch (error) {
      // Nothing is running: do not leave a player card for a session that never started
      console.error('[TtsSession] failed to start', error)
      this.toast?.error(this.str('MessageTtsFailedToStart'))
      await this.cleanup(true, true)
    } finally {
      this.starting = false
    }
  }

  async startSession({ book, startCfi, meta, bookFromReader }) {
    // A session restored after the app was closed has nothing running: start over it without stopping
    if (this.active && !this.store.state.tts.restored) await this.stop()
    this.bookFromReader = bookFromReader
    // Only one thing owns playback. Android pauses the audiobook natively when read aloud starts; iOS needs telling
    if (this.app?.$platform === 'ios') await AbsAudioPlayer.pausePlayer?.().catch(() => {})
    const { libraryItem, localLibraryItem } = meta
    const metadata = book.packaging?.metadata || {}
    this.book = book
    this.meta = meta
    this.currentCfi = startCfi
    this.store.commit('tts/setSession', {
      libraryItemId: libraryItem?.id,
      serverLibraryItemId: meta.serverLibraryItemId,
      localLibraryItemId: meta.localLibraryItemId,
      libraryItem,
      localLibraryItem,
      title: libraryItem?.media?.metadata?.title || metadata.title || '',
      author: libraryItem?.media?.metadata?.authorName || metadata.creator || '',
      progress: meta.progress,
      chapters: this.buildChapters(book)
    })
    if (meta.keepProgress) this.persist(true)
    else this.forgetPersisted()

    this.nativeListeners = [
      await AbsTts.addListener('sentence', (data) => this.onSentence(data)),
      // iOS reports the length of the word, Android where it ends
      await AbsTts.addListener('word', (data) => this.store.commit('tts/setWord', { id: data.id, start: data.start, end: data.end ?? data.start + data.length })),
      await AbsTts.addListener('state', (data) => {
        this.store.commit('tts/setPlaying', data.playing)
        if (!data.playing) {
          this.saveProgressNow()
          this.persist(true)
        }
        // The app was swiped away: keep the session so it is offered again (paused) when the app is reopened
        if (data.reason === 'removed' && this.active) {
          this.saveProgressNow()
          this.persist(true)
          this.cleanup(false, false)
        } else if (data.reason === 'stopped' && this.active) {
          // The service was stopped natively (e.g. an audiobook started playing)
          this.cleanup(false, true)
        }
      }),
      await AbsTts.addListener('needMore', () => {
        if (this.sender && !this.sender.running && !this.sender.done && !this.sender.failed) this.sender.run()
      }),
      await AbsTts.addListener('ended', async () => {
        // Finished the book: report it as read before forgetting the session
        if (this.currentCfi && this.meta) await this.saveProgress({ ebookLocation: this.currentCfi, ebookProgress: 1 }).catch((error) => console.error(error))
        this.stop()
      }),
      await AbsTts.addListener('sleepTimer', (data) => this.onSleepTimer(data)),
      await AbsTts.addListener('error', (data) => {
        console.error('[TtsSession] error', data)
        this.toast?.error(data.message || this.str('MessageTtsError'))
      })
    ]

    const sender = this.createSender({ startCfi, startSpine: book.spine.get(startCfi)?.index || 0 })

    await AbsTts.start({
      libraryItemId: libraryItem?.id,
      localLibraryItemId: localLibraryItem?.id,
      title: this.store.state.tts.title,
      author: this.store.state.tts.author,
      lang: metadata.language,
      coverUri: this.coverUriFor(meta),
      rate: this.store.state.tts.rate,
      pitch: 1,
      streamId: this.streamId
    })
    this.runSender(sender)
    await AbsTts.play()
  }

  // --- Remembering the session across app restarts ---

  /** Saves where we are so the app can show this session again when it is reopened */
  persist(force = false) {
    if (!this.meta || !this.active || !this.meta.keepProgress) return
    if (!force && Date.now() - this.lastPersistedAt < PERSIST_INTERVAL) return
    this.lastPersistedAt = Date.now()
    try {
      const m = this.meta
      localStorage.setItem(
        LAST_SESSION_KEY,
        JSON.stringify({
          libraryItem: trimLibraryItem(m.libraryItem),
          localLibraryItem: trimLocalLibraryItem(m.localLibraryItem),
          url: m.url,
          isLocal: m.isLocal,
          serverLibraryItemId: m.serverLibraryItemId,
          localLibraryItemId: m.localLibraryItemId,
          keepProgress: m.keepProgress,
          // The session belongs to whoever was signed in to this server: not offered to anyone else
          userId: this.store.state.user.user?.id || null,
          serverAddress: this.store.getters['user/getServerAddress'] || null,
          cfi: this.currentCfi,
          progress: this.store.state.tts.progress
        })
      )
    } catch (error) {
      // localStorage can be unavailable
    }
  }

  forgetPersisted() {
    try {
      localStorage.removeItem(LAST_SESSION_KEY)
    } catch (error) {
      // localStorage can be unavailable
    }
  }

  /**
   * At app start: when read-aloud was last in use show it again, paused, where it was.
   * Nothing is loaded until the listener presses play (see `resume`).
   */
  restore() {
    if (this.active) return
    let saved = null
    try {
      saved = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || 'null')
    } catch (error) {
      saved = null
    }
    if (!saved?.libraryItem?.id || !saved.cfi || !saved.url) return
    const user = this.store.state.user.user
    const serverAddress = this.store.getters['user/getServerAddress']
    // Signed in as someone else or to another server (a downloaded book has no user or server to compare when offline)
    if ((user && saved.userId && user.id !== saved.userId) || (serverAddress && saved.serverAddress && serverAddress !== saved.serverAddress)) {
      this.forgetPersisted()
      return
    }
    this.meta = { ...saved }
    this.currentCfi = saved.cfi
    this.store.commit('tts/setRestoredSession', {
      libraryItemId: saved.libraryItem.id,
      serverLibraryItemId: saved.serverLibraryItemId,
      localLibraryItemId: saved.localLibraryItemId,
      libraryItem: saved.libraryItem,
      localLibraryItem: saved.localLibraryItem,
      title: saved.libraryItem.media?.metadata?.title || '',
      author: saved.libraryItem.media?.metadata?.authorName || '',
      progress: saved.progress
    })
  }

  /** The user finished loading after a session was restored: if it belongs to someone else, forget it */
  checkRestoredOwner() {
    const m = this.meta
    const user = this.store.state.user.user
    if (!this.store.state.tts.restored || !m || !user || !m.userId || user.id === m.userId) return
    this.cleanup(false, true)
  }

  /** The listener pressed play on a restored session: open the book and carry on from where it was */
  async resume() {
    const meta = this.meta
    if (!meta || !this.store.state.tts.restored) return
    try {
      const book = await this.openBook(meta)
      await this.start({ book, startCfi: meta.cfi, meta })
    } catch (error) {
      console.error('[TtsSession] failed to resume', error)
      this.toast?.error(this.str('MessageTtsFailedToOpenBook'))
    }
  }

  /** Opens the epub without a reader */
  async openBook(meta) {
    const customRequest = async (url) => this.app.$axios.$get(url, { responseType: 'arraybuffer' })
    const book = new ePub(meta.url, { openAs: 'epub', requestMethod: meta.isLocal ? null : customRequest })
    await book.ready
    try {
      // Location data the reader generated gives the progress percentage
      const raw = localStorage.getItem(`ebookLocations-${meta.libraryItem?.id}`)
      const locations = raw && JSON.parse(raw).locations
      if (locations) book.locations.load(locations)
      // Not generated by the reader yet: without them there is no progress percentage and no seeking by percent
      else book.locations.generate(100).catch((error) => console.warn('[TtsSession] failed to generate locations', error))
    } catch (error) {
      console.warn('[TtsSession] failed to load locations', error)
    }
    return book
  }

  // --- Saving the reading position (the reader saves it too while it is open) ---

  /** Same as the reader: the device's own progress and the server's */
  async saveProgress(payload) {
    const m = this.meta
    if (!m?.keepProgress) return
    await saveEbookProgress(this.app, { localLibraryItemId: m.localLibraryItemId, serverLibraryItemId: m.serverLibraryItemId }, payload)
  }

  saveProgressNow() {
    if (!this.currentCfi || !this.meta) return
    this.lastSavedAt = Date.now()
    const payload = { ebookLocation: this.currentCfi }
    if (this.book?.locations?.length()) payload.ebookProgress = this.book.locations.percentageFromCfi(this.currentCfi)
    this.saveProgress(payload).catch((error) => console.error('[TtsSession] failed to save progress', error))
  }

  /** Native stop plus cleanup. The listener closed the player or the book ended: forget the session */
  async stop() {
    this.saveProgressNow()
    await this.cleanup(true, true)
  }

  async cleanup(stopNative = false, forget = false) {
    this.sender?.cancel()
    this.sender = null
    clearInterval(this.sleepInterval)
    this.sleepEndsAt = 0
    this.nativeListeners.forEach((l) => l.remove())
    this.nativeListeners = []
    this.sentenceHandlers.forEach((h) => h.onStopped?.())
    // The reader that handed over its Book still uses it while it is open
    if (!(this.bookFromReader && this.readerAttached)) {
      try {
        this.book?.destroy()
      } catch (error) {
        console.warn('[TtsSession] failed to destroy book', error)
      }
    }
    this.book = null
    this.bookFromReader = false
    this.meta = null
    if (forget) this.forgetPersisted()
    this.store?.commit('tts/clear')
    if (stopNative) await AbsTts.stop()
  }

  async playPause() {
    if (this.store.state.tts.restored) return this.resume()
    if (this.store.state.tts.playing) await AbsTts.pause()
    else await AbsTts.play()
  }

  skip(count) {
    if (this.store.state.tts.restored) return
    AbsTts.skip({ by: 'sentence', count })
  }

  /**
   * The reader registers here while it is open so it can highlight the sentence being read.
   * @param {{ onSentence: (data: {cfi: string}) => void, onStopped?: () => void }} handler
   */
  attachReader(handler) {
    this.sentenceHandlers.add(handler)
  }

  detachReader(handler) {
    this.sentenceHandlers.delete(handler)
  }

  get readerAttached() {
    return this.sentenceHandlers.size > 0
  }

  /** Where chapter `index` starts and ends in the book as percentages, from the reader's location data. 0/0 when not known. */
  chapterRange(index) {
    const locations = this.book?.locations
    const { chapters } = this.store.state.tts
    if (!locations?.length() || !chapters[index]) return { start: 0, end: 0 }
    // The first text position of the section: sorts before everything else in it
    const percentAt = (chapter) => {
      const section = this.book.spine.get(chapter.spine)
      const pct = section ? locations.percentageFromCfi(`epubcfi(${section.cfiBase}!/4/1:0)`) : NaN
      return typeof pct === 'number' && pct >= 0 ? pct * 100 : NaN
    }
    const start = percentAt(chapters[index])
    const next = chapters[index + 1]
    const end = next ? percentAt(next) : 100
    if (isNaN(start) || isNaN(end) || end <= start) return { start: 0, end: 0 }
    return { start, end }
  }

  /** @param {number} percent 0-100 within the current chapter */
  async seekToPercentInChapter(percent) {
    const { chapterStart, chapterEnd } = this.store.state.tts
    if (chapterEnd <= chapterStart) return this.seekToPercent(percent)
    return this.seekToPercent(chapterStart + (Math.min(Math.max(percent, 0), 100) / 100) * (chapterEnd - chapterStart))
  }

  /** Chapter for the spine item being read: the last table of contents entry at or before it */
  updateCurrentChapter(spine) {
    if (typeof spine !== 'number') return
    const chapters = this.store.state.tts.chapters
    let index = -1
    for (let i = 0; i < chapters.length && chapters[i].spine <= spine; i++) index = i
    if (index !== this.store.state.tts.currentChapterIndex) {
      this.store.commit('tts/setCurrentChapterIndex', index)
      this.store.commit('tts/setChapterRange', this.chapterRange(index))
      this.sentencesIntoChapter = 0
    }
    this.sentencesIntoChapter = (this.sentencesIntoChapter || 0) + 1
    this.currentSpine = spine
  }

  /** Current native state, used when the app or reader comes back to the foreground */
  async getState() {
    const state = await AbsTts.getState()
    // Native is not up yet while the session is starting: that is not a session that died
    if (this.starting) return state
    if (!state.active && this.active && !this.store.state.tts.restored) {
      await this.cleanup()
    } else if (this.active) {
      this.store.commit('tts/setPlaying', state.playing)
    }
    return state
  }

  onSentence(data) {
    this.currentCfi = data.cfi
    this.store.commit('tts/setCurrentSentence', data.id)
    this.updateCurrentChapter(data.spine)
    this.sentenceHandlers.forEach((h) => h.onSentence(data))

    if (this.book?.locations?.length()) {
      const pct = this.book.locations.percentageFromCfi(data.cfi)
      if (typeof pct === 'number' && !isNaN(pct) && pct >= 0) this.store.commit('tts/setProgress', pct * 100)
    }

    this.persist()
    // The reader saves progress itself while it is open (relocated)
    if (!this.readerAttached && Date.now() - this.lastSavedAt > SAVE_PROGRESS_INTERVAL) this.saveProgressNow()
  }
}

export default new TtsSession()
