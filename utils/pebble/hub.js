/**
 * The Pebble watch's one access point to playing books. All the decisions live here, in JavaScript, so Android and iOS share
 * them: which of the two ways of playing (the audiobook player, or an EPUB read aloud) the watch is steering, keeping the other
 * quiet, the shelves of books to choose from, the speed, the pages of the lists and what each message to the watch holds.
 *
 * Native code only supplies the primitives below (`native`) and moves the messages (`native.pebble.send`). Nothing in it
 * decides anything. To port to a platform, implement the primitives there:
 *
 *   audio.state()            -> { live, playing, time, speed, lastUpdatedAt, session: { title, duration, chapters: [{ title, start, end }] } | null }
 *                               `live`: the player is running; `session` is the loaded book, or the one played last
 *   audio.playPause()        -> { loading?, title?, error? }   toggles; with nothing healthy loaded it loads the book played last
 *   audio.pause()
 *   audio.jump(forward)      the app's own skip amounts
 *   audio.setSpeed(speed)    the one place the audiobook speed changes: saves it and tells the app's screen
 *   audio.start({ libraryItemId, localLibraryItemId }) -> { loading?, error? }   from the download when there is one
 *   audio.awaitPlaying()     -> { playing, error? }   waits for a started book to really play (platform workarounds live here)
 *   tts.state()              -> { live, playing, rate, snapshot: { title, chapter, chapterNumber, chapterCount, progress, updatedAt,
 *                                 chapterStart, chapterEnd, session } | null }
 *   tts.playPause()          the running read-aloud service toggles
 *   tts.pause()
 *   tts.skip(forward)
 *   tts.setRate(rate)        the one place the reading speed changes: saves it, applies it and tells the app's screen
 *   tts.resume(session)      opens a saved read-aloud session without the app's screen and carries on
 *   tts.startNew({ libraryItemId, localLibraryItemId, title, cfi, progress })   reads a book that was never read aloud
 *   device.volume()          -> step
 *   device.adjustVolume(direction)   +1 or -1
 *   api.get(path)            -> { ok, json }   a request to the signed-in server
 *   api.lastLibraryId()      -> string | null
 *   local.books()            -> [{ id, libraryItemId, title, hasAudio, hasEpub }]   the downloads
 *   local.ebookProgress(id)  -> { ebookLocation, ebookProgress } | null
 *   pebble.send(items)       items: [[keyId, type, value], ...]
 */
import { CMD, FORMAT_ASK, KEY, KIND, LEVEL, LIST_PAGE_SIZE, MAX_LABEL_LENGTH, MAX_LIST_ROWS, MAX_SPEED, MAX_TITLE_LENGTH, MIN_SPEED, MIN_TTS_SPEED, STATE } from './protocol'

const PROGRESS_STEP_SECONDS = 20 // the bar on the watch moves in steps of this size
const HELLO_DEDUPE_MS = 2000
const TTS_WAIT_SECONDS = 45
/** The shelves are answered from memory for this long; an open after it also starts a refresh (in the background) */
export const SHELVES_TTL_MS = 30000

const FORMAT = { AUDIO: 'audio', EPUB: 'epub' }

/** [current] moved by [step], in whole tenths so repeated steps do not drift (1.2000001) */
export const nextSpeed = (current, step, min = MIN_SPEED) => Math.min(MAX_SPEED, Math.max(min, Math.round(current * 10 + step * 10) / 10))

const formatsOf = (book) => [...(book.hasAudio ? [FORMAT.AUDIO] : []), ...(book.hasEpub ? [FORMAT.EPUB] : [])]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createHub(native, { log = () => {}, now = () => Date.now() } = {}) {
  let shelves = [] // what the lists show: the server's shelves, then the downloads
  let serverCache = null // { libraryId, server: [shelf], at } from the last load that worked; null until one has
  let localBooks = []
  let refreshing = null // the load under way, shared by everyone who asks while it runs
  let starting = false // a start is under way: the player reports paused until it plays
  let lastSentAt = 0
  let lastWatched = null
  let watcher = null

  // --- Messages to the watch ---

  const send = async (items) => {
    lastSentAt = now()
    await native.pebble.send(items)
  }
  /** A status sent to the watch is also the watcher's baseline, so the watcher does not send the same change again */
  const sendStatus = async (s) => {
    lastWatched = s
    await send(statusItems(s))
  }

  const statusItems = (s) => [
    [KEY.State.id, 'u8', s.state],
    [KEY.Title.id, 'text', (s.title || '').slice(0, MAX_TITLE_LENGTH)],
    [KEY.Chapter.id, 'text', (s.chapter || '').slice(0, MAX_TITLE_LENGTH)],
    [KEY.Position.id, 'u32', s.position || 0],
    [KEY.Duration.id, 'u32', s.duration || 0],
    [KEY.ChapterNumber.id, 'u16', s.chapterNumber || 0],
    [KEY.ChapterCount.id, 'u16', s.chapterCount || 0],
    [KEY.ChapterPosition.id, 'u32', s.chapterPosition || 0],
    [KEY.ChapterDuration.id, 'u32', s.chapterDuration || 0],
    [KEY.Kind.id, 'u8', s.kind || KIND.AUDIO],
    [KEY.Volume.id, 'u8', s.volume || 0],
    [KEY.Speed.id, 'u16', s.speed || 0]
  ]

  const listItems = (list) => [
    [KEY.List.id, 'text', list.labels.join('\n')],
    [KEY.ListLevel.id, 'u8', list.level],
    [KEY.ListTotal.id, 'u8', list.total],
    [KEY.ListStart.id, 'u8', list.start]
  ]

  const errorStatus = (message) => ({ state: STATE.ERROR, title: message })

  // --- What is playing ---

  /**
   * The read-aloud is what the user is listening to when it is reading, or (when nothing plays) it was used after the audiobook
   * was. Otherwise the audiobook player is.
   */
  async function pick() {
    const [audio, tts] = await Promise.all([native.audio.state(), native.tts.state()])
    const audioPlaying = audio.live && audio.playing
    const readAloud = !!tts.snapshot && (tts.playing || (!audioPlaying && tts.snapshot.updatedAt > (audio.lastUpdatedAt || 0)))
    return { audio, tts, readAloud }
  }

  function audioStatus(audio) {
    const session = audio.session
    if (!session) return { state: STATE.NOTHING_TO_PLAY, title: '', speed: Math.round(audio.speed * 100) }
    const time = Math.max(0, audio.time || 0)
    const chapters = session.chapters || []
    const index = chapters.findIndex((c) => time >= c.start && time < c.end)
    const chapter = index >= 0 ? chapters[index] : null
    return {
      state: audio.playing ? STATE.PLAYING : STATE.PAUSED,
      title: session.title,
      chapter: chapter ? chapter.title : '',
      chapterNumber: chapter ? index + 1 : 0,
      chapterCount: chapters.length,
      position: Math.floor(time),
      duration: Math.floor(Math.max(0, session.duration || 0)),
      kind: KIND.AUDIO,
      chapterPosition: chapter ? Math.floor(Math.max(0, time - chapter.start)) : 0,
      chapterDuration: chapter ? Math.floor(Math.max(0, chapter.end - chapter.start)) : 0,
      speed: Math.round(audio.speed * 100)
    }
  }

  function ttsStatus(tts, state) {
    const s = tts.snapshot
    const hasRange = s.chapterEnd > s.chapterStart
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
    return {
      state: state ?? (tts.playing ? STATE.PLAYING : STATE.PAUSED),
      title: s.title,
      chapter: s.chapter,
      chapterNumber: s.chapterNumber,
      chapterCount: s.chapterCount,
      // The percentage in hundredths of a percent: the watch shows it as "42%" and draws the bar from it
      position: Math.floor(clamp(s.progress, 0, 100) * 100),
      duration: 10000,
      kind: KIND.EPUB,
      chapterPosition: hasRange ? Math.floor(clamp(s.progress - s.chapterStart, 0, s.chapterEnd - s.chapterStart) * 100) : 0,
      chapterDuration: hasRange ? Math.floor((s.chapterEnd - s.chapterStart) * 100) : 0,
      speed: Math.round(tts.rate * 100)
    }
  }

  async function status() {
    const picked = await pick()
    const s = picked.readAloud ? ttsStatus(picked.tts) : audioStatus(picked.audio)
    s.volume = await native.device.volume()
    return s
  }

  const withVolume = async (s) => ({ ...s, volume: await native.device.volume() })

  /** A book is being started: the real state follows when it plays (see [awaitPlaying]) */
  const loadingStatus = async (title, kind, speed) => {
    starting = true
    return withVolume({ state: STATE.LOADING, title, kind, speed })
  }

  /** After a start: waits until it really plays, or says why not */
  async function awaitPlaying(kind) {
    try {
      if (kind === KIND.EPUB) {
        for (let i = 0; i < TTS_WAIT_SECONDS; i++) {
          await sleep(1000)
          if ((await native.tts.state()).playing) return status()
        }
        return withVolume(errorStatus("Could not start reading aloud. Check the phone's connection and try again"))
      }
      const result = await native.audio.awaitPlaying()
      if (result.playing) return status()
      return withVolume(errorStatus(result.error || "Could not start playback. Check the phone's connection and try again"))
    } finally {
      starting = false
    }
  }

  // --- Commands that act on what is playing ---

  async function playPause() {
    const { audio, tts, readAloud } = await pick()
    if (readAloud) {
      // Only one thing owns playback: when reading starts, the audiobook is paused first
      if (!tts.playing) await native.audio.pause()
      if (!tts.live) {
        if (!tts.snapshot.session) return errorStatus('Read aloud once in the app first')
        await native.tts.resume(tts.snapshot.session)
        return loadingStatus(tts.snapshot.title, KIND.EPUB, Math.round(tts.rate * 100))
      }
      await native.tts.playPause()
      return status()
    }
    // Nothing loaded and no book played before: nothing to resume, so nothing is started (and no failure is shown)
    if (!audio.session) return withVolume(audioStatus(audio))
    if (!(audio.live && audio.playing)) await native.tts.pause()
    // Not loaded (the app was closed, or the book failed to load): the primitive loads the book played last and starts it
    const result = await native.audio.playPause()
    if (result.error) return errorStatus(result.error)
    if (result.loading) return loadingStatus(result.title || '', KIND.AUDIO, Math.round(audio.speed * 100))
    return status()
  }

  async function skip(forward) {
    const { audio, tts, readAloud } = await pick()
    if (readAloud) {
      if (tts.live) await native.tts.skip(forward) // not running: skipping has no meaning
    } else if (audio.session) {
      await native.audio.jump(forward)
    }
    return status()
  }

  async function changeSpeed(step) {
    const { audio, tts, readAloud } = await pick()
    if (readAloud) await native.tts.setRate(nextSpeed(tts.rate, step, MIN_TTS_SPEED))
    else await native.audio.setSpeed(nextSpeed(audio.speed, step))
    return status()
  }

  /** Play the most recent book: what the home screen shortcut does. Never pauses: when it is already playing or starting nothing changes. */
  async function startPlaying() {
    const now = await status()
    if (now.state === STATE.PLAYING || now.state === STATE.LOADING) return now
    return playPause()
  }

  // --- Choosing a book: the shelves of the home screen, then the downloads ---

  /** The library the signed-in server keeps its books in: the last one used, else the first book library */
  async function resolveLibraryId() {
    const last = await native.api.lastLibraryId()
    if (last) return last
    const libraries = await native.api.get('/api/libraries')
    if (!libraries.ok) throw new Error('Could not list the libraries')
    return (libraries.json.libraries || []).find((l) => l.mediaType === 'book')?.id || null
  }

  /** The book shelves of a library from the server, one request. Throws when the server does not answer (not an empty list). */
  async function serverShelves(libraryId) {
    if (!libraryId) return []
    const response = await native.api.get(`/api/libraries/${libraryId}/personalized?minified=1`)
    if (!response.ok || !Array.isArray(response.json)) throw new Error('Could not load the shelves')
    return response.json
      .filter((shelf) => shelf.type === 'book')
      .map((shelf) => ({
        label: shelf.label,
        books: (shelf.entities || [])
          .filter((item) => item.mediaType === 'book' && !item.collapsedSeries)
          .map((item) => ({
            libraryItemId: item.id,
            localLibraryItemId: null,
            title: item.media?.metadata?.title || '',
            hasAudio: (item.media?.numTracks || 0) > 0,
            hasEpub: String(item.media?.ebookFormat || '').toLowerCase() === 'epub'
          }))
          .filter((book) => book.hasAudio || book.hasEpub)
      }))
      .filter((shelf) => shelf.books.length)
  }

  /** The server's shelves as loaded, then the downloads: what the lists show */
  function currentShelves() {
    const downloads = localBooks
      .filter((b) => b.hasAudio || b.hasEpub)
      .map((b) => ({ libraryItemId: b.libraryItemId || null, localLibraryItemId: b.id, title: b.title, hasAudio: b.hasAudio, hasEpub: b.hasEpub }))
    return [...(serverCache ? serverCache.server : []), ...(downloads.length ? [{ label: 'Downloaded', books: downloads }] : [])]
  }

  const shelvesStale = () => !serverCache || now() - serverCache.at > SHELVES_TTL_MS

  /** One load: the server's shelves (a failed load keeps the ones before, unless they are of another library) and the downloads */
  async function loadShelves() {
    try {
      const libraryId = await resolveLibraryId()
      if (serverCache && serverCache.libraryId !== libraryId) serverCache = null // another server or library: none of its shelves are kept
      serverCache = { libraryId, server: await serverShelves(libraryId), at: now() }
    } catch (error) {
      log('Could not load the server shelves: keeping the ones loaded before', error)
    }
    localBooks = await native.local.books()
  }

  /** Starts a load unless one is under way; everyone who asks meanwhile waits for the same one. Never rejects. */
  function refreshShelves() {
    if (!refreshing) {
      refreshing = loadShelves()
        .catch((error) => log('Could not refresh the shelves', error))
        .finally(() => {
          refreshing = null
          shelves = currentShelves()
        })
    }
    return refreshing
  }

  /** Warms the shelves when the watchapp opens, so the first Books list is answered from memory */
  function prefetchShelves() {
    if (shelvesStale()) refreshShelves()
  }

  /** The rows [start] and on of [all], as many as fit one message */
  function page(level, all, start) {
    const total = Math.min(all.length, MAX_LIST_ROWS)
    const labels = all
      .slice(0, total)
      .slice(start, start + LIST_PAGE_SIZE)
      .map((label) => String(label).replace(/\n/g, ' ').slice(0, MAX_LABEL_LENGTH))
    return { level, total, start, labels }
  }

  async function browse(args) {
    if (args.level === LEVEL.SHELVES) {
      // The top list is asked for when Books is opened. Answered at once from the shelves in memory; a load that is due runs in the
      // background, and only the very first open (nothing in memory yet) waits for it
      if (args.item === 0) {
        const libraryId = await native.api.lastLibraryId()
        if (serverCache && libraryId && serverCache.libraryId !== libraryId) serverCache = null // the server changed: its shelves are not shown
        if (!serverCache) await refreshShelves()
        else if (shelvesStale()) refreshShelves()
        shelves = currentShelves()
      }
      return { list: page(LEVEL.SHELVES, shelves.map((s) => s.label), args.item) }
    }
    if (args.level === LEVEL.BOOKS) return { list: page(LEVEL.BOOKS, (shelves[args.shelf]?.books || []).map((b) => b.title), args.item) }
    return { status: errorStatus('Unknown list') }
  }

  async function startBook(args) {
    const book = shelves[args.shelf]?.books[args.item]
    if (!book) return { status: errorStatus('That book is gone: open the list again') }
    const formats = formatsOf(book)
    if (!formats.length) return { status: errorStatus('Nothing to play in this book') }
    let format
    if (args.format === FORMAT_ASK) {
      // Two ways to play it: the watch picks one, from a list of two rows
      if (formats.length > 1) return { list: page(LEVEL.FORMATS, formats.map((f) => (f === FORMAT.AUDIO ? 'Audiobook' : 'Read aloud (EPUB)')), 0) }
      format = formats[0]
    } else {
      format = formats[args.format]
      if (!format) return { status: errorStatus('That way of reading is not available') }
    }
    return { status: format === FORMAT.EPUB ? await startEpub(book) : await startAudiobook(book) }
  }

  async function startAudiobook(book) {
    await native.tts.pause() // only one thing owns playback
    const localLibraryItemId = book.localLibraryItemId || localBooks.find((b) => b.libraryItemId && b.libraryItemId === book.libraryItemId && b.hasAudio)?.id || null
    const result = await native.audio.start({ libraryItemId: book.libraryItemId, localLibraryItemId })
    if (result.error) return errorStatus(result.error)
    return loadingStatus(book.title, KIND.AUDIO, Math.round((await native.audio.state()).speed * 100))
  }

  /** From where the server (or the download) has the reader, or the start */
  async function ebookPlace(book) {
    if (book.localLibraryItemId) return (await native.local.ebookProgress(book.localLibraryItemId)) || {}
    const response = await native.api.get(`/api/me/progress/${book.libraryItemId}`)
    return response.ok ? response.json || {} : {}
  }

  async function startEpub(book) {
    await native.audio.pause() // only one thing owns playback
    const place = await ebookPlace(book)
    const cfi = String(place.ebookLocation || '').startsWith('epubcfi') ? place.ebookLocation : ''
    await native.tts.startNew({
      libraryItemId: book.libraryItemId,
      localLibraryItemId: book.localLibraryItemId,
      title: book.title,
      cfi,
      progress: (place.ebookProgress || 0) * 100
    })
    return loadingStatus(book.title, KIND.EPUB, Math.round((await native.tts.state()).rate * 100))
  }

  // --- The watch ---

  /** One command from the watch: the answer is sent as it becomes known (a start answers LOADING first, and PLAYING when it does) */
  async function run(command, args) {
    switch (command) {
      case CMD.PLAY_PAUSE:
        return { status: await playPause() }
      case CMD.SKIP_FORWARD:
        return { status: await skip(true) }
      case CMD.SKIP_BACK:
        return { status: await skip(false) }
      case CMD.VOLUME_UP:
      case CMD.VOLUME_DOWN:
        await native.device.adjustVolume(command === CMD.VOLUME_UP ? 1 : -1)
        return { status: await status() }
      case CMD.SPEED_UP:
        return { status: await changeSpeed(0.1) }
      case CMD.SPEED_DOWN:
        return { status: await changeSpeed(-0.1) }
      case CMD.BROWSE:
        return browse(args)
      case CMD.START_BOOK:
        return startBook(args)
      default:
        return { status: await status() }
    }
  }

  async function answer(result) {
    if (result.list) return send(listItems(result.list))
    await sendStatus(result.status)
    if (result.status.state === STATE.LOADING) await sendStatus(await awaitPlaying(result.status.kind))
  }

  /**
   * @param {Object<string, number|string>} message the watch's message, by key number. Each message is handled on its own, in the
   * order it arrives, whatever came before it: a play/pause before the watch's hello is answered like any other.
   */
  async function handle(message) {
    const command = message[KEY.Command.id]
    if (command === undefined) return
    // The status was just sent when the watchapp opened: the watch's own hello needs no second copy (it would refuse it)
    if (command === CMD.HELLO) {
      if (now() - lastSentAt < HELLO_DEDUPE_MS) return
      lastSentAt = now() // set before the status is read, so an opened() that arrives meanwhile does not send it again
    }
    const args = {
      level: message[KEY.ListLevel.id] ?? 0,
      shelf: message[KEY.ArgShelf.id] ?? 0,
      item: message[KEY.ArgItem.id] ?? 0,
      format: message[KEY.ArgFormat.id] ?? FORMAT_ASK
    }
    try {
      await answer(await run(command, args))
    } catch (error) {
      // A failed primitive still gets an answer: the watch shows the failure at once instead of "No answer" after its timeout
      log('command failed', error)
      await sendStatus(errorStatus('Could not do that. Try again'))
    }
  }

  /**
   * While the watchapp is open, tell the watch when the player changes without the watch asking: started or paused from the
   * phone or a headset, a new chapter, or progress.
   */
  function watch() {
    clearInterval(watcher)
    lastWatched = null
    watcher = setInterval(async () => {
      try {
        const s = await status()
        const before = lastWatched
        if (!before) {
          lastWatched = s
          return
        }
        // A command from the watch is answered by its own message; LOADING is followed by awaitPlaying
        if (s.state === STATE.LOADING || starting) return
        const moved = Math.abs((s.position || 0) - (before.position || 0)) >= PROGRESS_STEP_SECONDS
        if (s.state !== before.state || s.kind !== before.kind || s.title !== before.title || s.speed !== before.speed || s.chapter !== before.chapter || moved) {
          lastWatched = s
          await send(statusItems(s))
        }
      } catch (error) {
        log('watch failed', error)
      }
    }, 1000)
  }

  /** The watchapp was opened */
  async function opened() {
    // The watch's hello may already have sent it (both set lastSentAt before they read the player)
    if (now() - lastSentAt >= HELLO_DEDUPE_MS) {
      lastSentAt = now()
      await sendStatus(await status())
    }
    watch()
    prefetchShelves()
  }

  function closed() {
    clearInterval(watcher)
    watcher = null
  }

  return { handle, opened, closed, status, startPlaying, awaitPlaying }
}
