import assert from 'assert'
import { execSync } from 'child_process'
import { partStep, retryOutcome, hasAvailableSpace, downloadsModule, STALL_TIMEOUT_MS, MAX_RETRIES, MAX_AUTH_RETRIES, MIN_FREE_SPACE_BYTES } from './modules/downloads'

// Every test quotes the Kotlin line it ports. `quote` reads that line from the Kotlin source at master 7a40e510 and checks the
// needle is on it, so a quoted line that drifts from the source fails the test.
const ROOT = process.cwd()
const MASTER = '7a40e510'
const FILE = 'android/app/src/main/java/com/audiobookshelf/app/managers/DownloadItemManager.kt'
let lines = null
function quote(line, needle) {
  if (!lines) lines = execSync(`git show ${MASTER}:${FILE}`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString().split('\n')
  const text = lines[line - 1]
  assert.ok(text !== undefined && text.includes(needle), `${FILE}:${line} does not contain '${needle}': ${text}`)
  return text.trim()
}

const NOW = 1_000_000_000

const tests = {
  'constants match the Kotlin': () => {
    quote(787, 'STALL_TIMEOUT_MS = 60_000L')
    quote(788, 'MAX_RETRIES = 5')
    quote(789, 'MAX_AUTH_RETRIES = 2')
    quote(791, 'MIN_FREE_SPACE_BYTES = 100L * 1024L * 1024L')
    assert.strictEqual(STALL_TIMEOUT_MS, 60000)
    assert.strictEqual(MAX_RETRIES, 5)
    assert.strictEqual(MAX_AUTH_RETRIES, 2)
    assert.strictEqual(MIN_FREE_SPACE_BYTES, 100 * 1024 * 1024)
  },

  'partStep: item gone is dropped (handlePartUpdate, item lookup)': () => {
    quote(342, 'val item =')
    assert.deepStrictEqual(partStep({ nowMs: NOW, lastUpdateMs: NOW, hasItem: false, completed: false, failed: false, isInternal: true }), { action: 'gone' })
  },

  'partStep: transferring with no update yet waits (lastUpdateTime ?: return)': () => {
    quote(349, 'val lastUpdate = part.lastUpdateTime ?: return')
    assert.deepStrictEqual(partStep({ nowMs: NOW, lastUpdateMs: null, hasItem: true, completed: false, failed: false, isInternal: true }), { action: 'wait' })
  },

  'partStep: stall is strictly more than 60 s': () => {
    quote(350, 'System.currentTimeMillis() - lastUpdate > STALL_TIMEOUT_MS')
    const at = (ms) => partStep({ nowMs: NOW + ms, lastUpdateMs: NOW, hasItem: true, completed: false, failed: false, isInternal: true }).action
    assert.strictEqual(at(STALL_TIMEOUT_MS), 'wait') // exactly 60 s is not a stall
    assert.strictEqual(at(STALL_TIMEOUT_MS + 1), 'stalled')
    assert.strictEqual(at(1000), 'wait')
  },

  'partStep: failed is checked before finalization': () => {
    quote(357, 'if (part.failed) {')
    assert.strictEqual(partStep({ nowMs: NOW, lastUpdateMs: NOW, hasItem: true, completed: true, failed: true, isInternal: true }).action, 'failed')
    assert.strictEqual(partStep({ nowMs: NOW, lastUpdateMs: NOW, hasItem: true, completed: false, failed: true, isInternal: false }).action, 'failed')
  },

  'partStep: completed goes to internal finalize or SAF move (isInternalStorage)': () => {
    quote(361, 'if (part.isInternalStorage) finalizeInternalFile(item, part) else moveDownloadedFile(item, part)')
    assert.strictEqual(partStep({ nowMs: NOW, lastUpdateMs: NOW, hasItem: true, completed: true, failed: false, isInternal: true }).action, 'finalizeInternal')
    assert.strictEqual(partStep({ nowMs: NOW, lastUpdateMs: NOW, hasItem: true, completed: true, failed: false, isInternal: false }).action, 'moveSaf')
  },

  'retryOutcome transfer: count+1, terminal when more than MAX_RETRIES': () => {
    quote(367, 'part.retryCount += 1')
    quote(369, 'if (part.retryCount > MAX_RETRIES) {')
    assert.deepStrictEqual(retryOutcome({ kind: 'transfer', count: 0 }), { count: 1, terminal: false, max: 5 })
    assert.strictEqual(retryOutcome({ kind: 'transfer', count: 4 }).terminal, false) // the 5th retry is still allowed
    assert.deepStrictEqual(retryOutcome({ kind: 'transfer', count: 5 }), { count: 6, terminal: true, max: 5 })
  },

  'retryOutcome auth: count+1, terminal when more than MAX_AUTH_RETRIES': () => {
    quote(390, 'part.authRetryCount += 1')
    quote(392, 'if (part.authRetryCount > MAX_AUTH_RETRIES) {')
    assert.deepStrictEqual(retryOutcome({ kind: 'auth', count: 1 }), { count: 2, terminal: false, max: 2 })
    assert.deepStrictEqual(retryOutcome({ kind: 'auth', count: 2 }), { count: 3, terminal: true, max: 2 })
  },

  'retryOutcome: a bad kind is an error, not a guess': () => {
    assert.throws(() => retryOutcome({ kind: 'stall', count: 0 }))
  },

  'hasAvailableSpace: available >= max(100 MiB, total / 20)': () => {
    quote(616, 'private fun hasAvailableSpace(part: DownloadItemPart): Boolean {')
    quote(619, 'return fs.availableBytes >= max(MIN_FREE_SPACE_BYTES, fs.totalBytes / 20L)')
    const GiB = 1024 ** 3
    // small disk: the 100 MiB floor wins (total/20 = 5 MiB)
    assert.strictEqual(hasAvailableSpace({ availableBytes: 100 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 }).ok, true)
    assert.strictEqual(hasAvailableSpace({ availableBytes: 100 * 1024 * 1024 - 1, totalBytes: 100 * 1024 * 1024 }).ok, false)
    // big disk: total/20 wins (128 GiB -> 6.4 GiB headroom)
    assert.strictEqual(hasAvailableSpace({ availableBytes: 6 * GiB, totalBytes: 128 * GiB }).ok, false)
    assert.strictEqual(hasAvailableSpace({ availableBytes: 7 * GiB, totalBytes: 128 * GiB }).ok, true)
  },

  'module serves the three calls on the downloads connector': () => {
    const served = new Map()
    const bridge = { serve: (c, m, fn) => served.set(c + '/' + m, fn) }
    downloadsModule(bridge)
    assert.deepStrictEqual([...served.keys()].sort(), ['downloads/hasSpace', 'downloads/partStep', 'downloads/retryOutcome'])
    assert.deepStrictEqual(served.get('downloads/retryOutcome')({ kind: 'auth', count: 2 }), { count: 3, terminal: true, max: 2 })
    assert.strictEqual(served.get('downloads/hasSpace')({ availableBytes: 0, totalBytes: 1 }).ok, false)
  }
}

let passed = 0
let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn()
    passed++
  } catch (e) {
    failed++
    console.log('not ok - ' + name + '\n   ' + (e && e.message))
  }
}
console.log(`downloads: ${passed} ok${failed ? ', ' + failed + ' failed' : ''}`)
if (failed) process.exit(1)
