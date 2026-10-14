import { registerPlugin, WebPlugin } from '@capacitor/core'

class AbsTtsWeb extends WebPlugin {
  async start() {}
  async appendChunk() {}
  async prependChunk() {}
  async play() {}
  async pause() {}
  async stop() {}
  async skip() {}
  async seekToSentence() {}
  async reset() {}
  async setRate() {}
  async setPitch() {}
  async setVoice() {}
  async setSleepTimer() {}
  async adjustSleepTimer() {}
  async cancelSleepTimer() {}
  async getSnapshot() {
    return {}
  }
  async saveSnapshot() {}
  async clearSnapshot() {}
  async getWindow() {
    return { sentences: [], currentId: null }
  }
  async getVoices() {
    return { voices: [] }
  }
  async getState() {
    return { active: false, playing: false, currentCfi: null }
  }
}

const AbsTts = registerPlugin('AbsTts', {
  web: () => new AbsTtsWeb()
})

export { AbsTts }
