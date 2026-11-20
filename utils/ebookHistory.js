/**
 * The reading history of an ebook, like the history of an audiobook (pages/media/_id/history.vue): where the listener was when
 * read aloud started or stopped, and where they were before they jumped to a chapter or to an older place in the history. Tap one to go back.
 * Kept on the device (localStorage), newest last, at most MAX_EVENTS per book.
 */
export const MAX_EVENTS = 100

export const EVENT = { START: 'Start', STOP: 'Stop', JUMP: 'Jump' }

const key = (itemId) => `ebookHistory-${itemId}`

/** @returns {Array<{timestamp:number,name:string,cfi:string,progress:number|null}>} oldest first */
export function loadHistory(itemId, storage = globalThis.localStorage) {
  if (!itemId) return []
  try {
    const events = JSON.parse(storage.getItem(key(itemId)) || '[]')
    return Array.isArray(events) ? events.filter((e) => e && typeof e.cfi === 'string' && e.cfi.startsWith('epubcfi')) : []
  } catch (error) {
    return []
  }
}

/**
 * Adds an event. The same place twice in a row is not added again (a stop right after a start in the same place, a jump from where the
 * history already ends), but the newer event name wins so the list shows the latest reason.
 * @param {string|null} itemId
 * @param {string} name one of EVENT
 * @param {string} cfi
 * @param {number|null} [progress] 0 to 1
 */
export function addHistoryEvent(itemId, name, cfi, progress = null, storage = globalThis.localStorage, now = Date.now()) {
  if (!itemId || !cfi || !String(cfi).startsWith('epubcfi')) return
  try {
    const events = loadHistory(itemId, storage)
    const last = events[events.length - 1]
    if (last && last.cfi === cfi) {
      last.name = name
      last.timestamp = now
      if (typeof progress === 'number') last.progress = progress
    } else {
      events.push({ timestamp: now, name, cfi, progress: typeof progress === 'number' ? progress : null })
    }
    storage.setItem(key(itemId), JSON.stringify(events.slice(-MAX_EVENTS)))
  } catch (error) {
    // localStorage can be unavailable or full: the history is a convenience
  }
}
