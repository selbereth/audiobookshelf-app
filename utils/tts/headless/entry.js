/**
 * Read aloud without the app's screen. Bundled by `npm run build:tts-headless` into android/.../assets/tts-headless/ and
 * run by `TtsHeadless.kt` in a WebView nobody sees, so the Pebble watch can start reading when the app is closed.
 * It is the same session code as the app's (ttsSession.js): it opens the EPUB, cuts it into sentences and feeds the
 * native speech queue. Only the plumbing differs: no Vue app, the book comes from native code and saved progress goes
 * through native code (callNative).
 */
import Vue from 'vue'
import Vuex from 'vuex'
import * as tts from '../../../store/tts'
import ttsSession from '../ttsSession'
import { callNative } from './capacitor-shim'

Vue.use(Vuex)

const store = new Vuex.Store({
  modules: {
    tts: { namespaced: true, state: tts.state, getters: tts.getters, mutations: tts.mutations },
    // The parts of the app's store that the session reads
    user: { namespaced: true, state: () => ({ user: null }), getters: { getServerAddress: () => null } },
    globals: { namespaced: true, getters: { getLibraryItemCoverSrcById: () => () => '' }, mutations: { updateLocalMediaProgress() {} } }
  }
})

const app = {
  $platform: 'android',
  $strings: {},
  $store: store,
  $db: { updateLocalEbookProgress: (payload) => callNative('updateLocalEbookProgress', payload) },
  $nativeHttp: { patch: (url, payload) => callNative('patchProgress', { url, payload }) }
}
const toast = { error: (message) => console.error('[headless]', message), info: () => {} }

ttsSession.init(store, toast, app)
// The file comes from native code (local file or the server, with the signed in user's token)
ttsSession.loadBookData = async (meta) => {
  const { base64 } = await callNative('fetchBook', { url: meta.url, isLocal: meta.isLocal, localLibraryItemId: meta.localLibraryItemId })
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

window.ttsHeadless = {
  /** Open the saved session and read on from where it was left */
  async resume(session) {
    ttsSession.restoreFrom(session)
    if (!store.state.tts.restored) throw new Error('nothing to resume')
    await ttsSession.resume()
  },
  /** The app's screen is opening: write down where the reading is and stop it, the screen carries on from there */
  async handOver() {
    ttsSession.saveProgressNow()
    ttsSession.persist(true)
    await ttsSession.cleanup(true, false)
  },
  /** Read aloud has finished or been stopped: write down where it was */
  saveNow() {
    ttsSession.saveProgressNow()
  }
}
