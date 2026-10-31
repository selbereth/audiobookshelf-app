/**
 * The page the shared Pebble logic runs in on Android (`PebbleHost.kt` loads it in a WebView nobody sees, built by
 * `npm run build:pebble-hub`). It only wires hub.js to the native primitives: every `native.x.y(...)` is a call by name to
 * `PebblePrimitives.kt`, and the page's `pebbleHub.run` is how native calls into hub.js.
 */
import { createHub } from './hub'

let nextId = 1
const pending = new Map()

/** Called by native with the answer to a primitive */
window.__hubReply = (id, ok, json) => {
  const call = pending.get(id)
  if (!call) return
  pending.delete(id)
  if (ok) call.resolve(json ? JSON.parse(json) : undefined)
  else call.reject(new Error(json || 'native call failed'))
}

const primitive = (method) => (args = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    window.NativeHub.invoke(method, JSON.stringify(args), id)
  })

const native = {
  audio: {
    state: primitive('audio.state'),
    playPause: primitive('audio.playPause'),
    pause: primitive('audio.pause'),
    jump: (forward) => primitive('audio.jump')({ forward }),
    setSpeed: (speed) => primitive('audio.setSpeed')({ speed }),
    start: primitive('audio.start'),
    awaitPlaying: primitive('audio.awaitPlaying')
  },
  tts: {
    state: primitive('tts.state'),
    playPause: primitive('tts.playPause'),
    pause: primitive('tts.pause'),
    skip: (forward) => primitive('tts.skip')({ forward }),
    setRate: (rate) => primitive('tts.setRate')({ rate }),
    resume: (session) => primitive('tts.resume')({ session }),
    startNew: primitive('tts.startNew')
  },
  device: {
    volume: primitive('device.volume'),
    adjustVolume: (direction) => primitive('device.adjustVolume')({ direction })
  },
  api: {
    get: (path) => primitive('api.get')({ path }),
    lastLibraryId: primitive('api.lastLibraryId')
  },
  local: {
    books: primitive('local.books'),
    ebookProgress: (id) => primitive('local.ebookProgress')({ id })
  },
  pebble: { send: (items) => primitive('pebble.send')({ items }) }
}

const hub = createHub(native, { log: (...args) => console.log(...args.map(String)) })

window.pebbleHub = {
  /** Native calls `hub[method](...args)`; what it returns (or why it failed) goes back through `NativeHub.done` */
  async run(callId, method, argsJson) {
    try {
      const result = await hub[method](...JSON.parse(argsJson))
      window.NativeHub.done(callId, true, JSON.stringify(result === undefined ? null : result))
    } catch (error) {
      console.error(`${method} failed: ${error && error.stack ? error.stack : error}`)
      window.NativeHub.done(callId, false, String(error))
    }
  }
}
