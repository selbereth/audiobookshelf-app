<template>
  <!-- The text being read aloud, laid out in paragraphs like in the book. The spoken position stays near the middle of
       the card: what was read is above it and slowly leaves the top, what is next is below. Not interactive. -->
  <div ref="viewport" class="read-aloud-text w-full h-full relative overflow-hidden select-none pointer-events-none" :style="{ backgroundColor: 'rgba(0, 0, 0, 0.18)' }">
    <div ref="list" class="absolute left-0 top-0 w-full px-4" style="will-change: transform">
      <p v-for="paragraph in paragraphs" :key="paragraph.key" class="paragraph">
        <template v-for="sentence in paragraph.sentences"><span :key="sentence.id" :data-id="sentence.id" class="sentence" :class="classFor(sentence.id)">{{ sentence.text }}</span>{{ ' ' }}</template>
      </p>
    </div>
  </div>
</template>

<script>
import { AbsTts } from '@/plugins/capacitor'

const BEFORE = 10 // sentences kept above the current one: the previous ones stay on screen while the current one is mid-card
const AFTER = 50 // sentences after it: more than fit on any screen
const REFILL_WHEN_AHEAD = 20 // ask native for a new window when fewer than this many sentences are left below the current one
const ANCHOR = 0.4 // where the spoken position is held, as a fraction of the card's height from the top
const DEFAULT_MS_PER_CHAR = 60 // at 1x, before the voice's speed has been measured
const SMOOTHING_MS = 450 // how slowly the text follows: larger is smoother and lags more
const RUN_AHEAD_CHARS = 30 // the voice is not assumed to be further than this past the last word it reported

export default {
  data() {
    return {
      /** @type {Array<{id: number, text: string, paragraph: number}>} */
      items: [],
      order: {}, // sentence id -> its position in items
      loading: false
    }
  },
  computed: {
    tts() {
      return this.$store.state.tts
    },
    currentId() {
      return this.tts.currentSentenceId
    },
    /** Sentences grouped into the paragraphs they belong to */
    paragraphs() {
      const groups = []
      for (const item of this.items) {
        const last = groups[groups.length - 1]
        if (last && last.paragraph === item.paragraph) last.sentences.push(item)
        else groups.push({ key: `p${item.paragraph}-${item.id}`, paragraph: item.paragraph, sentences: [item] })
      }
      return groups
    }
  },
  watch: {
    currentId() {
      this.onSentenceChange()
    },
    'tts.wordAt'() {
      this.onWord()
    },
    'tts.rate'() {
      this.msPerChar = DEFAULT_MS_PER_CHAR / this.tts.rate
    }
  },
  created() {
    // Not reactive: updated many times a second
    this.msPerChar = DEFAULT_MS_PER_CHAR / (this.tts.rate || 1)
    this.pos = 0 // how many characters of the current sentence the voice has spoken
    this.lastWord = null
    this.cur = null // where the current sentence is in the list: { top, bottom, length }
    this.y = 0 // how far the list is scrolled now
    this.needsSnap = true // the first position after opening is jumped to, not scrolled to
    this.raf = null
    this.lastFrame = 0
  },
  methods: {
    classFor(id) {
      const here = this.order[id]
      const now = this.order[this.currentId]
      if (here === undefined || now === undefined) return ''
      if (here < now) return 'past'
      return here === now ? 'current' : 'next'
    },
    async load() {
      if (this.loading) return
      this.loading = true
      // Where the current sentence is on screen now: kept the same when the text is replaced
      const visual = this.cur ? this.cur.top - this.y : null
      try {
        const result = await AbsTts.getWindow({ before: BEFORE, after: AFTER })
        this.items = result.sentences || []
        this.order = {}
        this.items.forEach((item, i) => (this.order[item.id] = i))
      } catch (error) {
        console.error('[ReadAloudText] failed to load the text', error)
      } finally {
        this.loading = false
      }
      await this.$nextTick()
      this.measure()
      if (this.cur) this.y = visual === null ? this.targetY() : this.cur.top - visual
    },
    onSentenceChange() {
      this.pos = 0
      this.lastWord = null
      const index = this.order[this.currentId]
      const ahead = index === undefined ? -1 : this.items.length - 1 - index
      if (ahead < REFILL_WHEN_AHEAD) return this.load()
      this.$nextTick(() => this.measure())
    },
    /** The voice reached a word: it is at the start of it. Learn how fast it is speaking from the time between words. */
    onWord() {
      const { wordStart, wordAt } = this.tts
      if (this.lastWord && wordStart > this.lastWord.start) {
        const perChar = (wordAt - this.lastWord.at) / (wordStart - this.lastWord.start)
        if (perChar > 5 && perChar < 400) this.msPerChar = 0.6 * this.msPerChar + 0.4 * perChar
      }
      this.lastWord = { start: wordStart, at: wordAt }
      // The voice is exactly here: correct the running estimate
      this.pos = wordStart
    },
    /** Where the current sentence starts and ends in the list. A sentence can wrap over several lines. */
    measure() {
      const list = this.$refs.list
      const span = list?.querySelector(`[data-id="${this.currentId}"]`)
      if (!span) {
        this.cur = null
        return
      }
      const rects = span.getClientRects()
      if (!rects.length) return
      // Rects include the list's current scroll: take it out
      const listTop = list.getBoundingClientRect().top
      this.cur = { top: rects[0].top - listTop, bottom: rects[rects.length - 1].bottom - listTop, length: Math.max(1, span.textContent.length) }
    },
    /** The scroll that puts the spoken position at ANCHOR of the card's height */
    targetY() {
      const viewport = this.$refs.viewport
      if (!this.cur || !viewport) return this.y
      const progress = Math.min(1, this.pos / this.cur.length)
      return Math.max(0, this.cur.top + progress * (this.cur.bottom - this.cur.top) - viewport.clientHeight * ANCHOR)
    },
    /** Every frame: the voice moves on by the time passed, and the text follows it smoothly */
    frame(now) {
      this.raf = requestAnimationFrame(this.frame)
      const dt = Math.min(100, now - (this.lastFrame || now))
      this.lastFrame = now
      const list = this.$refs.list
      if (!list || !this.cur) return
      if (this.tts.playing) {
        // Between words the voice is assumed to carry on at the speed measured so far, but not far past the last word it reported
        const limit = this.lastWord ? this.lastWord.start + RUN_AHEAD_CHARS : this.cur.length
        this.pos = Math.min(this.cur.length, limit, this.pos + dt / this.msPerChar)
      }
      const target = this.targetY()
      const height = this.$refs.viewport ? this.$refs.viewport.clientHeight : 0
      if (height > 0 && (this.needsSnap || Math.abs(target - this.y) > height * 1.5)) {
        // Opening the view (or a seek far away): the text is simply there, it does not ride down from the top
        this.y = target
        this.needsSnap = false
      } else {
        this.y += (target - this.y) * (1 - Math.exp(-dt / SMOOTHING_MS))
      }
      list.style.transform = `translate3d(0, ${-this.y}px, 0)`
    },
    onResize() {
      this.$nextTick(() => this.measure())
    }
  },
  mounted() {
    this.load()
    this.raf = requestAnimationFrame(this.frame)
    window.addEventListener('resize', this.onResize)
  },
  beforeDestroy() {
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.onResize)
  }
}
</script>

<style>
.read-aloud-text {
  /* Text fades in at the bottom and out at the top: it is arriving and leaving, not cut off */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 8%, #000 88%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 8%, #000 88%, transparent 100%);
}
.read-aloud-text .paragraph {
  font-size: 1.2rem;
  line-height: 1.6;
  margin: 0 0 0.8em 0;
  text-indent: 1.4em;
}
.read-aloud-text .sentence {
  transition: opacity 0.4s;
}
.read-aloud-text .sentence.past {
  opacity: 0.4;
}
.read-aloud-text .sentence.next {
  opacity: 0.8;
}
.read-aloud-text .sentence.current {
  font-weight: 500;
  background-color: rgba(250, 204, 21, 0.22);
  border-radius: 4px;
  padding: 1px 0;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
</style>
