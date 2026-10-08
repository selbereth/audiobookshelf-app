/**
 * Batches sentences from a sentenceStream into chunks and sends them to the native AbsTts plugin.
 * Chunks are independent of chapter boundaries. The first chunk is small so speech starts quickly.
 */

const FIRST_CHUNK_SENTENCES = 4
const CHUNK_SENTENCES = 50
const CHUNK_BYTES = 8000

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0))

export class ChunkSender {
  /**
   * @param {object} params
   * @param {AsyncGenerator} params.stream - sentence generator
   * @param {number} params.streamId
   * @param {(chunk: object) => Promise<any>} params.send - delivers a chunk to native
   */
  constructor({ stream, streamId, send }) {
    this.stream = stream
    this.streamId = streamId
    this.send = send
    this.seq = 0
    this.done = false
    this.cancelled = false
    this.running = false
    /** Seqs below this are already delivered; used to answer needMore */
    this.paused = false
  }

  async run() {
    if (this.running) return
    this.running = true
    let batch = []
    let bytes = 0
    try {
      for await (const sentence of this.stream) {
        if (this.cancelled) return
        batch.push(sentence)
        bytes += sentence.text.length
        const limit = this.seq === 0 ? FIRST_CHUNK_SENTENCES : CHUNK_SENTENCES
        if (batch.length >= limit || bytes >= CHUNK_BYTES) {
          await this.flush(batch, false)
          batch = []
          bytes = 0
          await yieldToEventLoop()
        }
      }
      if (this.cancelled) return
      this.done = true
      await this.flush(batch, true)
    } catch (error) {
      console.error('[tts] ChunkSender failed', error)
    } finally {
      this.running = false
    }
  }

  async flush(sentences, done) {
    if (this.cancelled) return
    await this.send({ streamId: this.streamId, seq: this.seq++, sentences, done })
  }

  cancel() {
    this.cancelled = true
  }
}
