import ePub from 'epubjs'

/**
 * Walks an epub.js book and yields speakable sentences with a CFI for each.
 */

/** Elements that start and end a run of text: the text before and after one is never part of the same sentence */
const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'blockquote', 'figure', 'figcaption', 'td', 'th', 'tr', 'table', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'pre', 'details', 'summary', 'body', 'hr'])
const SKIP_TAGS = new Set(['script', 'style', 'rt', 'rp', 'noscript', 'head', 'svg', 'math'])
const FOOTNOTE_TYPES = ['noteref', 'footnote', 'endnote', 'rearnote', 'note']
const FOOTNOTE_ROLES = ['doc-noteref', 'doc-footnote', 'doc-endnote']
const MAX_SENTENCE_LENGTH = 1000
// Sentences before the start location that are kept so the listener can rewind
const HISTORY_SENTENCES = 60
// A book has to fit in memory twice (here and in the native queue): stop at an absurd size
const MAX_SENTENCES = 250000

function epubTypes(el) {
  return (el.getAttribute?.('epub:type') || el.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') || '').toLowerCase().split(/\s+/)
}

function isSkippedElement(el, options) {
  const tag = el.localName?.toLowerCase()
  if (SKIP_TAGS.has(tag)) return true
  if (el.hidden || el.getAttribute?.('aria-hidden') === 'true') return true
  const style = el.getAttribute?.('style') || ''
  if (/display\s*:\s*none/i.test(style)) return true
  const types = epubTypes(el)
  if (types.includes('pagebreak') || el.getAttribute?.('role') === 'doc-pagebreak') return true
  if (!options.readFootnotes) {
    // An aside is only skipped when it is a footnote: asides can also be sidebars and pull quotes that belong to the text
    if (FOOTNOTE_TYPES.some((t) => types.includes(t))) return true
    if (FOOTNOTE_ROLES.includes(el.getAttribute?.('role'))) return true
  }
  return false
}

/**
 * The text of a document in reading order, as runs of text nodes. Every block element ends the run before it
 * and starts a new one, so text outside any paragraph (directly in a section or div) is read too, and text
 * around a nested block (`<li>text<ul>..</ul></li>`) is read in the order it appears.
 * @returns {Generator<{nodes: Array<{node: Node, start: number}>, text: string}>}
 */
function* textRuns(body, options) {
  let nodes = []
  let text = ''
  const runs = []
  const flush = () => {
    if (nodes.length && text.trim()) runs.push({ nodes, text })
    nodes = []
    text = ''
  }
  // Iterative walk: documents can be deeply nested
  const stack = [{ el: body, child: body.firstChild }]
  while (stack.length) {
    const frame = stack[stack.length - 1]
    const node = frame.child
    if (!node) {
      stack.pop()
      if (BLOCK_TAGS.has(frame.el.localName)) flush()
      continue
    }
    frame.child = node.nextSibling
    if (node.nodeType === 3) {
      const value = node.nodeValue
      if (value) {
        nodes.push({ node, start: text.length })
        text += value
      }
    } else if (node.nodeType === 1) {
      if (isSkippedElement(node, options)) continue
      if (node.localName === 'br') {
        // A line break separates words that would otherwise be glued together ("line one<br/>line two")
        text += ' '
        continue
      }
      if (BLOCK_TAGS.has(node.localName)) flush()
      stack.push({ el: node, child: node.firstChild })
    }
  }
  flush()
  yield* runs
}

function locate(nodes, offset) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (offset >= nodes[i].start) return { node: nodes[i].node, offset: offset - nodes[i].start }
  }
  return null
}

function splitLongSentence(text, start) {
  if (text.length <= MAX_SENTENCE_LENGTH) return [{ text, start }]
  const pieces = []
  let remaining = text
  let pos = start
  while (remaining.length > MAX_SENTENCE_LENGTH) {
    const window = remaining.slice(0, MAX_SENTENCE_LENGTH)
    let cut = Math.max(window.lastIndexOf(';'), window.lastIndexOf(','))
    if (cut < MAX_SENTENCE_LENGTH / 2) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = MAX_SENTENCE_LENGTH - 1
    pieces.push({ text: remaining.slice(0, cut + 1), start: pos })
    remaining = remaining.slice(cut + 1)
    pos += cut + 1
  }
  if (remaining.length) pieces.push({ text: remaining, start: pos })
  return pieces
}

function getSegmenter(lang) {
  try {
    return new Intl.Segmenter(lang || undefined, { granularity: 'sentence' })
  } catch (error) {
    return null
  }
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'inc', 'ltd', 'no', 'fig', 'gen', 'col', 'lt', 'capt', 'sgt', 'rev', 'hon'])

function segment(segmenter, text) {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => ({ text: s.segment, start: s.index }))
  // Without Intl.Segmenter: split after . ! ? unless it follows an abbreviation like "Mr."
  const out = []
  const re = /[^.!?]+(?:[.!?]+|$)\s*/g
  let m
  let carry = null
  while ((m = re.exec(text))) {
    const piece = carry ? { text: carry.text + m[0], start: carry.start } : { text: m[0], start: m.index }
    const word = piece.text.trimEnd().match(/([A-Za-z]+)\.$/)?.[1]?.toLowerCase()
    if (word && ABBREVIATIONS.has(word) && re.lastIndex < text.length) {
      carry = piece
      continue
    }
    carry = null
    out.push(piece)
    if (re.lastIndex >= text.length) break
  }
  if (carry) out.push(carry)
  return out
}

/** Paragraph numbers are unique across sections so a section boundary is never mistaken for a paragraph */
const PARAGRAPHS_PER_SECTION = 100000

/**
 * Sentences of one spine item in document order
 * @returns {AsyncGenerator<{text:string,cfi:string,spine:number,paragraph:number}>}
 */
async function* readSection(book, spineIndex, segmenter, options) {
  const section = book.spine.get(spineIndex)
  if (!section) return
  try {
    await section.load(book.load.bind(book))
  } catch (error) {
    console.error('[tts] failed to load section', spineIndex, error)
    return
  }
  const doc = section.document
  const body = doc?.body
  if (!body) {
    section.unload?.()
    return
  }

  let paragraph = spineIndex * PARAGRAPHS_PER_SECTION
  for (const { nodes, text } of textRuns(body, options)) {
    paragraph++

    for (const seg of segment(segmenter, text)) {
      for (const piece of splitLongSentence(seg.text, seg.start)) {
        const trimmed = piece.text.replace(/\s+/g, ' ').trim()
        if (!/[\p{L}\p{N}]/u.test(trimmed)) continue
        const leading = piece.text.length - piece.text.trimStart().length
        const startPos = locate(nodes, piece.start + leading)
        const endPos = locate(nodes, Math.max(piece.start + piece.text.trimEnd().length - 1, piece.start + leading))
        if (!startPos || !endPos) continue

        let cfi
        try {
          const range = doc.createRange()
          range.setStart(startPos.node, startPos.offset)
          range.setEnd(endPos.node, Math.min(endPos.offset + 1, endPos.node.nodeValue.length))
          cfi = section.cfiFromRange(range)
        } catch (error) {
          continue
        }
        yield { text: trimmed, cfi, spine: spineIndex, paragraph }
      }
    }
  }
  section.unload?.()
}

/**
 * @param {import('epubjs').Book} book
 * @param {object} opts
 * @param {number} [opts.startSpine] spine index of the start location (the previous section is read too, for rewinding)
 * @param {boolean} [opts.startAtSpine] start at the first sentence of `startSpine` (chapter jump) instead of at a CFI
 * @param {string} [opts.startCfi] the sentence at or after this CFI is flagged `atStart`; up to HISTORY_SENTENCES before it are yielded first
 * @param {string} [opts.continueAfterCfi] carry on after the sentence with this CFI (no history, no start flag): a new feeder taking over a stream
 * @param {number} [opts.firstId] the id of the first sentence yielded (with `continueAfterCfi`: the id after the last one already sent)
 * @param {boolean} [opts.readFootnotes]
 * @param {Set<string>} [opts.historyCfis] filled with the CFIs of the history sentences that were yielded
 * @param {{cancelled:boolean}} [opts.signal]
 * @returns {AsyncGenerator<{id:number,text:string,cfi:string,spine:number,paragraph:number,atStart?:boolean}>}
 */
export async function* sentenceStream(book, opts = {}) {
  const options = { readFootnotes: !!opts.readFootnotes }
  const segmenter = getSegmenter(book.packaging?.metadata?.language)
  let id = opts.firstId || 0
  const startSpine = opts.startSpine || 0
  const continueAfter = opts.continueAfterCfi || null
  const hasStart = !!opts.startCfi || !!opts.startAtSpine || !!continueAfter
  let pastStartCfi = !hasStart
  /** Sentences before the start location, held back until it is found */
  let history = []

  for (let spineIndex = hasStart ? Math.max(startSpine - 1, 0) : startSpine; spineIndex < book.spine.length; spineIndex++) {
    if (opts.signal?.cancelled) return
    for await (const sentence of readSection(book, spineIndex, segmenter, options)) {
      if (opts.signal?.cancelled) return
      if (!pastStartCfi) {
        // Hold sentences back (as history) until we reach the one containing the start CFI
        if (spineIndex < startSpine || (opts.startCfi && !isAtOrAfter(sentence.cfi, opts.startCfi)) ||
          (continueAfter && (sentence.cfi === continueAfter || !isAtOrAfter(sentence.cfi, continueAfter)))) {
          history.push(sentence)
          if (history.length > HISTORY_SENTENCES) history.shift()
          continue
        }
        pastStartCfi = true
        if (continueAfter) {
          // The text before this is already with the speech engine
          history = []
          yield { id: id++, ...sentence }
          continue
        }
        const held = history
        history = []
        for (const h of held) {
          opts.historyCfis?.add(h.cfi)
          yield { id: id++, ...h }
        }
        yield { id: id++, ...sentence, atStart: true }
        continue
      }
      if (id >= MAX_SENTENCES) return
      yield { id: id++, ...sentence }
    }
  }

  // Start location was past the end of the book: speak what we held back from the last sentence
  if (!pastStartCfi && history.length) {
    const held = history
    history = []
    for (let i = 0; i < held.length; i++) {
      opts.historyCfis?.add(held[i].cfi)
      yield { id: id++, ...held[i], atStart: i === held.length - 1 }
    }
  }
}

/**
 * Everything before the history window, so the listener can rewind to the very start of the book.
 * Yields one block per section, last section first: each block belongs in front of the previous ones.
 * Ids are negative and decreasing so they stay unique and sort before the forward stream.
 * @param {import('epubjs').Book} book
 * @param {object} opts
 * @param {number} opts.startSpine spine index of the start location
 * @param {string} [opts.startCfi] only sentences before it are produced from `startSpine` (none when absent)
 * @param {Set<string>} opts.historyCfis sentences already sent as history
 * @param {{cancelled:boolean}} [opts.signal]
 * @returns {AsyncGenerator<{spine:number,sentences:Array}>}
 */
export async function* earlierSections(book, opts) {
  const options = { readFootnotes: false }
  const segmenter = getSegmenter(book.packaging?.metadata?.language)
  let id = -1
  for (let spineIndex = opts.startSpine; spineIndex >= 0; spineIndex--) {
    if (opts.signal?.cancelled) return
    const block = []
    for await (const sentence of readSection(book, spineIndex, segmenter, options)) {
      if (opts.historyCfis.has(sentence.cfi)) continue
      if (spineIndex === opts.startSpine && (!opts.startCfi || isAtOrAfter(sentence.cfi, opts.startCfi))) continue
      block.push(sentence)
    }
    // Ids ascend within the block and every block is lower than the one before it
    const sentences = block.map((sentence, i) => ({ ...sentence, id: id - (block.length - 1 - i) }))
    id -= block.length
    // Empty blocks are yielded too: the caller tracks how far back the text is complete
    yield { spine: spineIndex, sentences }
  }
}

function isAtOrAfter(cfi, startCfi) {
  try {
    return new ePub.CFI().compare(cfi, startCfi) >= 0
  } catch (error) {
    return true
  }
}
