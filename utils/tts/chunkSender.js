/**
 * Batches sentences from a sentenceStream into chunks and sends them to the native AbsTts plugin.
 * Chunks are independent of chapter boundaries. The first chunk is small so speech starts quickly.
 */

const FIRST_CHUNK_SENTENCES = 4 // sentences after the start location in the first chunk
const CHUNK_SENTENCES = 50
const CHUNK_BYTES = 8000

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0))

export class ChunkSender {
  /**
   * @param {object} params
   * @param {AsyncGenerator} params.stream - sentence generator
   * @param {number} params.streamId
   * @param {(chunk: object) => Promise<any>} params.send - delivers a chunk to native
   * @param {(error: Error) => void} [params.onError]
   * @param {boolean} [params.expectStart] the stream flags the sentence to start at: the first chunk waits for it
   */
  constructor({ stream, streamId, send, onError, expectStart = true }) {
    this.onError = onError
    /** Producing the text failed part way: not the same as being done, so the native queue must not be told the book ended */
    this.failed = false
    this.expectStart = expectStart
    this.stream = stream
    this.streamId = streamId
    this.send = send
    this.seq = 0
    this.done = false
    this.cancelled = false
    this.running = false
  }

  async run() {
    if (this.running) return
    this.running = true
    let batch = []
    let bytes = 0
    let startId = null // id of the sentence to start speaking from
    let sentAfterStart = 0
    try {
      for await (const sentence of this.stream) {
        if (this.cancelled) return
        batch.push(sentence)
        bytes += sentence.text.length
        if (sentence.atStart) startId = sentence.id
        if (startId !== null && sentence.id >= startId) sentAfterStart++
        // The first chunk holds the rewind history plus a few sentences after the start so speech starts quickly
        const ready = this.seq === 0 ? (startId !== null ? sentAfterStart >= FIRST_CHUNK_SENTENCES : !this.expectStart && batch.length >= FIRST_CHUNK_SENTENCES) : batch.length >= CHUNK_SENTENCES || bytes >= CHUNK_BYTES
        if (ready) {
          await this.flush(batch, false, this.seq === 0 ? startId : null)
          batch = []
          bytes = 0
          await yieldToEventLoop()
        }
      }
      if (this.cancelled) return
      this.done = true
      await this.flush(batch, true, this.seq === 0 ? startId : null)
    } catch (error) {
      console.error('[tts] ChunkSender failed', error)
      this.failed = true
      this.onError?.(error)
    } finally {
      this.running = false
    }
  }

  async flush(sentences, done, startId = null) {
    if (this.cancelled) return
    const chunk = { streamId: this.streamId, seq: this.seq++, sentences, done }
    if (startId !== null) chunk.startId = startId
    await this.send(chunk)
  }

  cancel() {
    this.cancelled = true
  }
}
