import { registerPlugin, WebPlugin } from '@capacitor/core'

class AbsTtsWeb extends WebPlugin {
  async start() {}
  async appendChunk() {}
  async play() {}
  async pause() {}
  async stop() {}
  async skip() {}
  async seekToSentence() {}
  async reset() {}
  async setRate() {}
  async setPitch() {}
  async setVoice() {}
  async getVoices() {
    return { voices: [] }
  }
  async getState() {
    return { active: false, playing: false }
  }
}

const AbsTts = registerPlugin('AbsTts', {
  web: () => new AbsTtsWeb()
})

export { AbsTts }
