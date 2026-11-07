/**
 * Download decisions (Phase 8, slice 1: the per-part watcher step, the retry and auth counts, the free-space check).
 * Ported from android/app/src/main/java/com/audiobookshelf/app/managers/DownloadItemManager.kt. Every rule names its Kotlin
 * source (file:line, on master 7a40e510). Nothing here moves bytes: the transfer, the staging and the SAF copy stay native.
 *
 * It is used only while the switch `system.flags` {coreDownload} is on (CoreSwitch.coreDownload, read once per process,
 * default off). While it is off, DownloadItemManager's own rules run, as before.
 *
 * Calls in (native asks, native applies the answer):
 *   downloads.partStep {nowMs, lastUpdateMs, hasItem, completed, failed, isInternal}
 *       -> {action: gone | wait | stalled | failed | finalizeInternal | moveSaf}
 *   downloads.retryOutcome {kind: transfer | auth, count}  -> {count, terminal, max}
 *   downloads.hasSpace {availableBytes, totalBytes}        -> {ok}
 *
 * Not in this slice (see the vault questions note): the queue slots (checkUpdateDownloadQueue), the reservation maths
 * (tryReserve), the item finished check, the queue persistence, the completed-part finalization and the SAF copy.
 */

export const STALL_TIMEOUT_MS = 60000 // DownloadItemManager.kt:787 STALL_TIMEOUT_MS = 60_000L
export const MAX_RETRIES = 5 // DownloadItemManager.kt:788 MAX_RETRIES = 5
export const MAX_AUTH_RETRIES = 2 // DownloadItemManager.kt:789 MAX_AUTH_RETRIES = 2
export const MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024 // DownloadItemManager.kt:791 MIN_FREE_SPACE_BYTES = 100L * 1024L * 1024L
export const SPACE_DIVISOR = 20 // DownloadItemManager.kt:619 fs.totalBytes / 20L

/**
 * The watcher's step for one active part (DownloadItemManager.kt:340-362 handlePartUpdate). The order of the checks is the
 * Kotlin order. The caller applies the action: cancel and fail for `stalled`, fail or retry for `failed`, finalize otherwise.
 */
export function partStep({ nowMs, lastUpdateMs, hasItem, completed, failed, isInternal }) {
  // :342-344 the item is no longer in the queue: the part is dropped from the active list (removeActivePart)
  if (!hasItem) return { action: 'gone' }
  // :348 `if (!part.completed && !part.failed)`: still transferring
  if (!completed && !failed) {
    // :349 `val lastUpdate = part.lastUpdateTime ?: return`: no update yet, nothing to judge
    if (lastUpdateMs == null) return { action: 'wait' }
    // :350 `System.currentTimeMillis() - lastUpdate > STALL_TIMEOUT_MS` (strictly greater)
    if (nowMs - lastUpdateMs > STALL_TIMEOUT_MS) return { action: 'stalled' }
    return { action: 'wait' }
  }
  // :357 `if (part.failed)` is checked before the finalization
  if (failed) return { action: 'failed' }
  // :361 `if (part.isInternalStorage) finalizeInternalFile(...) else moveDownloadedFile(...)`
  return { action: isInternal ? 'finalizeInternal' : 'moveSaf' }
}

/**
 * One more failure of a part (DownloadItemManager.kt:367-370 failOrRetry: `retryCount += 1`, terminal when `> MAX_RETRIES`)
 * or one more 401 (:390-393 handleAuthError: `authRetryCount += 1`, terminal when `> MAX_AUTH_RETRIES`).
 */
export function retryOutcome({ kind, count }) {
  if (kind !== 'transfer' && kind !== 'auth') throw new Error('retryOutcome: kind must be transfer or auth')
  const max = kind === 'auth' ? MAX_AUTH_RETRIES : MAX_RETRIES
  const next = count + 1
  return { count: next, terminal: next > max, max }
}

/**
 * The free-space check before a transfer or a copy (DownloadItemManager.kt:616-619 hasAvailableSpace):
 * available >= max(100 MiB, total / 20).
 */
export function hasAvailableSpace({ availableBytes, totalBytes }) {
  const headroom = Math.max(MIN_FREE_SPACE_BYTES, Math.trunc(totalBytes / SPACE_DIVISOR))
  return { ok: availableBytes >= headroom }
}

export function downloadsModule(bridge) {
  const serve = (method, fn) => bridge.serve('downloads', method, (args) => fn(args || {}))
  serve('partStep', (a) => partStep(a))
  serve('retryOutcome', (a) => retryOutcome(a))
  serve('hasSpace', (a) => hasAvailableSpace(a))
  return { partStep, retryOutcome, hasAvailableSpace }
}
