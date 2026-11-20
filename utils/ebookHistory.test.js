import assert from 'node:assert'
import { addHistoryEvent, loadHistory, EVENT, MAX_EVENTS } from './ebookHistory.js'

const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v } } }
const s = mem()
addHistoryEvent('a', EVENT.START, 'epubcfi(/6/2)', 0.1, s, 1)
addHistoryEvent('a', EVENT.STOP, 'epubcfi(/6/2)', 0.1, s, 2) // same place: one row, newest name
addHistoryEvent('a', EVENT.JUMP, 'epubcfi(/6/8)', 0.4, s, 3)
addHistoryEvent('a', EVENT.JUMP, 'nonsense', 0.4, s, 4) // not a cfi: ignored
addHistoryEvent(null, EVENT.JUMP, 'epubcfi(/6/9)', 0.4, s, 5) // no item: ignored
const h = loadHistory('a', s)
assert.deepStrictEqual(h.map((e) => [e.name, e.cfi, e.timestamp]), [['Stop', 'epubcfi(/6/2)', 2], ['Jump', 'epubcfi(/6/8)', 3]])
for (let i = 0; i < MAX_EVENTS + 20; i++) addHistoryEvent('b', EVENT.JUMP, `epubcfi(/6/${i})`, null, s, i)
assert.strictEqual(loadHistory('b', s).length, MAX_EVENTS)
assert.deepStrictEqual(loadHistory('zzz', { getItem: () => { throw new Error('x') } }), [])
console.log('ebookHistory: ok')
