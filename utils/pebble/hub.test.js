/**
 * Run: npx esbuild utils/pebble/hub.test.js --bundle --platform=node --outfile=$TMPDIR/hub-test.js && node $TMPDIR/hub-test.js
 * The hub is plain JavaScript over a `native` object, so it is tested here with a made-up one.
 */
import assert from 'assert'
import { createHub, nextSpeed, SHELVES_TTL_MS } from './hub'
import { CMD, KEY, STATE, KIND, LEVEL } from './protocol'

const sent = []
const decode = (items) => Object.fromEntries(items.map(([id, , value]) => [Object.values(KEY).findIndex((k) => k.id === id) >= 0 ? Object.keys(KEY).find((n) => KEY[n].id === id) : id, value]))

function fakeNative(overrides = {}) {
  const calls = []
  const rec = (name, result) => async (...args) => {
    calls.push([name, ...args])
    return typeof result === 'function' ? result(...args) : result
  }
  const state = {
    audio: { live: true, playing: true, time: 125, speed: 1.5, lastUpdatedAt: 100, session: { title: 'Book One', duration: 3600, chapters: [{ title: 'Intro', start: 0, end: 100 }, { title: 'Two', start: 100, end: 400 }] } },
    tts: { live: false, playing: false, rate: 1, snapshot: null }
  }
  const native = {
    audio: {
      state: async () => state.audio,
      playPause: rec('audio.playPause', {}),
      pause: rec('audio.pause'),
      jump: rec('audio.jump'),
      setSpeed: rec('audio.setSpeed', (v) => { state.audio.speed = v }),
      start: rec('audio.start', {}),
      awaitPlaying: rec('audio.awaitPlaying', { playing: true })
    },
    tts: {
      state: async () => state.tts,
      playPause: rec('tts.playPause'),
      pause: rec('tts.pause'),
      skip: rec('tts.skip'),
      setRate: rec('tts.setRate', (v) => { state.tts.rate = v }),
      resume: rec('tts.resume'),
      startNew: rec('tts.startNew', () => { state.tts.playing = true; state.tts.live = true; state.tts.snapshot = { title: 'Book B', chapter: '', chapterNumber: 0, chapterCount: 0, progress: 25, updatedAt: 1e12, chapterStart: 0, chapterEnd: 0, session: '{}' } })
    },
    device: { volume: async () => 7, adjustVolume: rec('device.adjustVolume') },
    api: {
      get: async (path) => {
        calls.push(['api.get', path])
        if (path.startsWith('/api/libraries/lib1/personalized')) {
          return {
            ok: true,
            json: [
              { type: 'book', label: 'Continue Listening', entities: [{ id: 'a', mediaType: 'book', media: { metadata: { title: 'Book A' }, numTracks: 3 } }, { id: 'b', mediaType: 'book', media: { metadata: { title: 'Book B\nwith a very long title that does not fit the watch' }, numTracks: 2, ebookFormat: 'epub' } }] },
              { type: 'series', label: 'Series', entities: [{ id: 's', mediaType: 'book' }] },
              { type: 'book', label: 'Empty', entities: [{ id: 'x', mediaType: 'book', media: { metadata: { title: 'Pdf only' }, numTracks: 0, ebookFormat: 'pdf' } }] }
            ]
          }
        }
        if (path.startsWith('/api/me/progress/')) return { ok: true, json: { ebookLocation: 'epubcfi(/6/4)', ebookProgress: 0.25 } }
        return { ok: false }
      },
      lastLibraryId: async () => 'lib1'
    },
    local: { books: async () => [{ id: 'local_a', libraryItemId: 'a', title: 'Book A', hasAudio: true, hasEpub: false }], ebookProgress: async () => null },
    pebble: { send: async (items) => sent.push(decode(items)) },
    ...overrides
  }
  return { native, calls, state }
}

const cmd = (command, extra = {}) => ({ [KEY.Command.id]: command, ...extra })
const tests = []
const test = (name, fn) => tests.push([name, fn])

test('speed steps in whole tenths and stays in range', () => {
  assert.strictEqual(nextSpeed(1.2, 0.1), 1.3)
  assert.strictEqual(nextSpeed(0.8, -0.1), 0.7)
  assert.strictEqual(nextSpeed(3, 0.1), 3)
  assert.strictEqual(nextSpeed(0.5, -0.1), 0.5)
  assert.strictEqual(nextSpeed(0.2, -0.1, 0.1), 0.1)
  assert.strictEqual(nextSpeed(0.1, -0.1, 0.1), 0.1)
  assert.strictEqual(nextSpeed(2.5, 0.1), 2.6)
})

test('status of an audiobook: chapter, position and speed', async () => {
  const { native } = fakeNative()
  const hub = createHub(native)
  const s = await hub.status()
  assert.deepStrictEqual([s.state, s.title, s.chapter, s.chapterNumber, s.chapterCount, s.position, s.chapterPosition, s.chapterDuration, s.speed, s.volume], [STATE.PLAYING, 'Book One', 'Two', 2, 2, 125, 25, 300, 150, 7])
})

test('speed command changes the audiobook speed in one place and answers with it', async () => {
  sent.length = 0
  const { native, calls } = fakeNative()
  await createHub(native).handle(cmd(CMD.SPEED_UP))
  assert.deepStrictEqual(calls.find((c) => c[0] === 'audio.setSpeed'), ['audio.setSpeed', 1.6])
  assert.strictEqual(sent[0].Speed, 160)
})

test('read aloud is steered when it is playing, and the audiobook speed is left alone', async () => {
  sent.length = 0
  const { native, calls, state } = fakeNative()
  state.tts = { live: true, playing: true, rate: 1.2, snapshot: { title: 'Epub', chapter: 'C', chapterNumber: 2, chapterCount: 9, progress: 42.5, updatedAt: 500, chapterStart: 40, chapterEnd: 50, session: '{}' } }
  await createHub(native).handle(cmd(CMD.SPEED_DOWN))
  assert.deepStrictEqual(calls.find((c) => c[0] === 'tts.setRate'), ['tts.setRate', 1.1])
  assert.ok(!calls.find((c) => c[0] === 'audio.setSpeed'))
  assert.deepStrictEqual([sent[0].Kind, sent[0].Position, sent[0].Duration, sent[0].ChapterPosition, sent[0].ChapterDuration], [KIND.EPUB, 4250, 10000, 250, 1000])
})

test('starting read aloud pauses the audiobook first; a closed app resumes from the saved session', async () => {
  sent.length = 0
  const { native, calls, state } = fakeNative()
  state.audio.playing = false
  state.tts = { live: false, playing: false, rate: 1, snapshot: { title: 'Epub', chapter: '', chapterNumber: 0, chapterCount: 0, progress: 1, updatedAt: 500, chapterStart: 0, chapterEnd: 0, session: '{"a":1}' } }
  native.tts.state = async () => state.tts
  setTimeout(() => (state.tts.playing = true), 10)
  const hub = createHub(native)
  const task = hub.handle(cmd(CMD.PLAY_PAUSE))
  await task
  assert.deepStrictEqual(calls.map((c) => c[0]).slice(0, 2), ['audio.pause', 'tts.resume'])
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.LOADING, STATE.PLAYING])
})

test('browse: shelves, books, long labels cut, series and unplayable shelves left out, downloads last', async () => {
  sent.length = 0
  const { native } = fakeNative()
  const hub = createHub(native)
  await hub.handle(cmd(CMD.BROWSE, { [KEY.ListLevel.id]: LEVEL.SHELVES, [KEY.ArgItem.id]: 0 }))
  assert.deepStrictEqual([sent[0].ListLevel, sent[0].ListTotal, sent[0].ListStart, sent[0].List], [LEVEL.SHELVES, 2, 0, 'Continue Listening\nDownloaded'])
  await hub.handle(cmd(CMD.BROWSE, { [KEY.ListLevel.id]: LEVEL.BOOKS, [KEY.ArgShelf.id]: 0, [KEY.ArgItem.id]: 0 }))
  assert.strictEqual(sent[1].ListTotal, 2)
  assert.strictEqual(sent[1].List.split('\n')[1].length, 34)
  assert.ok(!sent[1].List.includes('\n\n'))
})

test('start: one format starts at once; two formats answer with the choice; the choice starts it', async () => {
  sent.length = 0
  const { native, calls } = fakeNative()
  const hub = createHub(native)
  await hub.handle(cmd(CMD.BROWSE, { [KEY.ListLevel.id]: LEVEL.SHELVES, [KEY.ArgItem.id]: 0 }))
  sent.length = 0
  // Book A: audio only, there is a download of it, so that is played
  await hub.handle(cmd(CMD.START_BOOK, { [KEY.ArgShelf.id]: 0, [KEY.ArgItem.id]: 0, [KEY.ArgFormat.id]: 255 }))
  assert.deepStrictEqual(calls.find((c) => c[0] === 'audio.start'), ['audio.start', { libraryItemId: 'a', localLibraryItemId: 'local_a' }])
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.LOADING, STATE.PLAYING])
  // Book B has both
  sent.length = 0
  await hub.handle(cmd(CMD.START_BOOK, { [KEY.ArgShelf.id]: 0, [KEY.ArgItem.id]: 1, [KEY.ArgFormat.id]: 255 }))
  assert.deepStrictEqual([sent[0].ListLevel, sent[0].List], [LEVEL.FORMATS, 'Audiobook\nRead aloud (EPUB)'])
  sent.length = 0
  await hub.handle(cmd(CMD.START_BOOK, { [KEY.ArgShelf.id]: 0, [KEY.ArgItem.id]: 1, [KEY.ArgFormat.id]: 1 }))
  const start = calls.find((c) => c[0] === 'tts.startNew')
  assert.deepStrictEqual(start[1], { libraryItemId: 'b', localLibraryItemId: null, title: 'Book B\nwith a very long title that does not fit the watch', cfi: 'epubcfi(/6/4)', progress: 25 })
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.LOADING, STATE.PLAYING])
})

test('a book that is gone, and a hello right after opening, are answered sensibly', async () => {
  sent.length = 0
  const { native } = fakeNative()
  let t = 0
  const hub = createHub(native, { now: () => t })
  await hub.handle(cmd(CMD.START_BOOK, { [KEY.ArgShelf.id]: 9, [KEY.ArgItem.id]: 9 }))
  assert.strictEqual(sent[0].State, STATE.ERROR)
  sent.length = 0
  await hub.handle(cmd(CMD.HELLO))
  assert.strictEqual(sent.length, 0) // just sent something
  t = 5000
  await hub.handle(cmd(CMD.HELLO))
  assert.strictEqual(sent.length, 1)
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('the app opening and the watch hello together send the status once', async () => {
  for (const order of ['opened-first', 'hello-first']) {
    sent.length = 0
    const { native } = fakeNative()
    const audioState = native.audio.state
    native.audio.state = async () => { await wait(50); return audioState() } // the status takes a while to read
    const hub = createHub(native)
    const calls = order === 'opened-first'
      ? [hub.opened(), hub.handle(cmd(CMD.HELLO))]
      : [hub.handle(cmd(CMD.HELLO)), hub.opened()]
    await Promise.all(calls)
    hub.closed()
    assert.strictEqual(sent.length, 1, order + ': ' + sent.length + ' messages')
  }
})

test('a command is answered once: the watcher does not send the same state again', async () => {
  sent.length = 0
  const { native, state } = fakeNative()
  native.audio.playPause = async () => { state.audio.playing = !state.audio.playing; return {} }
  const hub = createHub(native)
  await hub.opened() // sends PLAYING and starts the watcher
  await wait(1100) // the watcher takes PLAYING as its baseline
  await hub.handle(cmd(CMD.PLAY_PAUSE)) // answered PAUSED, once
  await wait(1100)
  hub.closed()
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.PLAYING, STATE.PAUSED])
})

test('play/pause with nothing loaded resumes the book played last, and starts nothing else', async () => {
  sent.length = 0
  const { native, calls, state } = fakeNative()
  state.audio = { live: false, playing: false, speed: 1, lastUpdatedAt: 0, session: { title: 'Last Book', duration: 600, chapters: [] } }
  native.audio.playPause = async () => {
    calls.push(['audio.playPause'])
    state.audio.live = true
    state.audio.playing = true // what the page's primitive does: load the book played last and start it
    return { loading: true, title: 'Last Book' }
  }
  await createHub(native).handle(cmd(CMD.PLAY_PAUSE))
  const names = calls.map((c) => c[0])
  assert.strictEqual(names.filter((n) => n === 'audio.playPause').length, 1)
  assert.ok(!names.includes('audio.start') && !names.includes('audio.jump'))
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.LOADING, STATE.PLAYING])
  assert.strictEqual(sent[0].Title, 'Last Book')
})

test('play/pause with nothing to resume answers a no-book status and starts nothing', async () => {
  sent.length = 0
  const { native, calls, state } = fakeNative()
  state.audio = { live: false, playing: false, speed: 1, lastUpdatedAt: 0, session: null }
  await createHub(native).handle(cmd(CMD.PLAY_PAUSE))
  const names = calls.map((c) => c[0])
  assert.ok(!names.includes('audio.playPause') && !names.includes('audio.start') && !names.includes('tts.resume') && !names.includes('tts.startNew'))
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.NOTHING_TO_PLAY])
})

test('a play/pause before the watch hello is answered; the hello after it is not sent again', async () => {
  sent.length = 0
  const { native, calls, state } = fakeNative()
  native.audio.playPause = async () => {
    calls.push(['audio.playPause'])
    state.audio.playing = false
    return {}
  }
  const hub = createHub(native, { now: () => 0 })
  await hub.handle(cmd(CMD.PLAY_PAUSE))
  await hub.handle(cmd(CMD.HELLO))
  assert.strictEqual(calls.filter((c) => c[0] === 'audio.playPause').length, 1)
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.PAUSED])
})

test('a failing primitive is answered with an error at once, not left to the watch timeout', async () => {
  sent.length = 0
  const { native } = fakeNative()
  native.audio.playPause = async () => { throw new Error('boom') }
  await createHub(native).handle(cmd(CMD.PLAY_PAUSE))
  assert.deepStrictEqual(sent.map((m) => m.State), [STATE.ERROR])
})

// --- The shelves: answered from memory, refreshed in the background, one load at a time ---

/** A server whose shelves can be changed, slowed (gate) or made to fail between the tests */
function shelvesNative() {
  const { native, calls } = fakeNative()
  const server = { libraryId: 'lib1', label: 'Continue Listening', fail: false, gate: null }
  const get = native.api.get
  native.api.get = async (path) => {
    if (!path.includes('/personalized')) return get(path)
    calls.push(['personalized', path])
    if (server.gate) await server.gate
    if (server.fail) return { ok: false }
    return { ok: true, json: [{ type: 'book', label: server.label, entities: [{ id: 'a', mediaType: 'book', media: { metadata: { title: 'Book A' }, numTracks: 3 } }] }] }
  }
  native.api.lastLibraryId = async () => server.libraryId
  return { native, calls, server }
}
const openShelves = (hub) => hub.handle(cmd(CMD.BROWSE, { [KEY.ListLevel.id]: LEVEL.SHELVES, [KEY.ArgItem.id]: 0 }))
const fetches = (calls) => calls.filter((c) => c[0] === 'personalized').length

test('a cached open is answered at once, without waiting for the refresh; the refresh shows at the next open', async () => {
  sent.length = 0
  const { native, server } = shelvesNative()
  let t = 0
  const hub = createHub(native, { now: () => t })
  await openShelves(hub) // nothing in memory yet: this one waits
  assert.strictEqual(sent[0].List, 'Continue Listening\nDownloaded')
  t = SHELVES_TTL_MS + 1 // stale now
  server.label = 'Discover'
  let release
  server.gate = new Promise((resolve) => (release = resolve))
  sent.length = 0
  const winner = await Promise.race([openShelves(hub).then(() => 'answered'), wait(200).then(() => 'waited')])
  assert.strictEqual(winner, 'answered')
  assert.strictEqual(sent[0].List, 'Continue Listening\nDownloaded')
  server.gate = null
  release()
  await wait(10)
  sent.length = 0
  await openShelves(hub)
  assert.strictEqual(sent[0].List, 'Discover\nDownloaded')
})

test('concurrent opens and the watchapp opening share one fetch', async () => {
  const { native, calls } = shelvesNative()
  const hub = createHub(native)
  await Promise.all([hub.opened(), openShelves(hub), openShelves(hub), hub.handle(cmd(CMD.HELLO))])
  assert.strictEqual(fetches(calls), 1)
  hub.closed()
})

test('a stale cache starts one background refresh on open', async () => {
  const { native, calls } = shelvesNative()
  let t = 0
  const hub = createHub(native, { now: () => t })
  await openShelves(hub)
  assert.strictEqual(fetches(calls), 1)
  t = SHELVES_TTL_MS + 1
  await openShelves(hub)
  await wait(10)
  assert.strictEqual(fetches(calls), 2)
  t = SHELVES_TTL_MS + 2 // fresh again: no new request
  await openShelves(hub)
  await wait(10)
  assert.strictEqual(fetches(calls), 2)
})

test('a failed refresh keeps the shelves in memory and logs it', async () => {
  sent.length = 0
  const { native, server } = shelvesNative()
  let t = 0
  const logs = []
  const hub = createHub(native, { now: () => t, log: (...args) => logs.push(args[0]) })
  await openShelves(hub)
  t = SHELVES_TTL_MS + 1
  server.fail = true
  await openShelves(hub)
  await wait(10)
  sent.length = 0
  await openShelves(hub)
  assert.strictEqual(sent[0].List, 'Continue Listening\nDownloaded')
  assert.ok(logs.some((m) => String(m).includes('keeping')))
})

test('a server change drops the old shelves: a failed load of the new server shows no old rows', async () => {
  sent.length = 0
  const { native, server } = shelvesNative()
  let t = 0
  const hub = createHub(native, { now: () => t })
  await openShelves(hub)
  server.libraryId = 'lib2'
  server.fail = true
  await openShelves(hub) // a change of library is seen at once: this open waits for the (failed) load
  assert.strictEqual(sent[sent.length - 1].List, 'Downloaded')
  server.fail = false
  server.label = 'Server two shelf'
  sent.length = 0
  await openShelves(hub)
  assert.strictEqual(sent[0].List, 'Server two shelf\nDownloaded')
})

let failed = 0
;(async () => {
for (const [name, fn] of tests) {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))])
    console.log('ok   ', name)
  } catch (error) {
    failed++
    console.log('FAIL ', name, '\n', error.stack)
  }
}
process.exit(failed ? 1 : 0)
})()
