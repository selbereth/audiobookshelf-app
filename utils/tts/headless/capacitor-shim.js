/**
 * Stands in for `@/plugins/capacitor` in the headless bundle (see entry.js). The read-aloud session talks to the native
 * AbsTts plugin through Capacitor; here there is no Capacitor, so the same calls go to the `NativeTts` object that
 * `TtsHeadless.kt` puts into the page.
 */
let nextId = 1
const pending = new Map()
const listeners = new Map()

/** Called by native with the answer to a call */
window.__ttsReply = (id, ok, json) => {
  const call = pending.get(id)
  if (!call) return
  pending.delete(id)
  if (ok) call.resolve(json ? JSON.parse(json) : undefined)
  else call.reject(new Error(json || 'native call failed'))
}

/** Called by native for the events the AbsTts plugin sends */
window.__ttsEvent = (name, json) => {
  const data = json ? JSON.parse(json) : {}
  for (const callback of listeners.get(name) || []) callback(data)
}

export function callNative(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    window.NativeTts.invoke(method, JSON.stringify(args), id)
  })
}

const methods = ['start', 'appendChunk', 'prependChunk', 'play', 'pause', 'stop', 'skip', 'seekToSentence', 'reset', 'setRate', 'setPitch', 'setVoice', 'setSleepTimer', 'adjustSleepTimer', 'cancelSleepTimer', 'getWindow', 'getVoices', 'getState', 'saveSnapshot', 'clearSnapshot', 'getSnapshot']

export const AbsTts = {
  addListener(name, callback) {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(callback)
    return Promise.resolve({ remove: () => listeners.get(name)?.delete(callback) })
  }
}
for (const method of methods) AbsTts[method] = (args) => callNative(method, args)

export const AbsAudioPlayer = {}
