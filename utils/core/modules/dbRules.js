/**
 * The rules of the local database, as pure functions on plain objects (the JSON the store holds). No bridge, no clock they do not
 * receive: db.js does the reading, writing and asking native about files. Moved from DbManager, DeviceManager, DeviceSettings,
 * LocalMediaProgress and AbsDatabase (Kotlin).
 */

export const COLLECTIONS = {
  device: 'device',
  localLibraryItems: 'localLibraryItems',
  localFolders: 'localFolders',
  localMediaProgress: 'localMediaProgress',
  mediaItemHistory: 'mediaItemHistory',
  playbackSession: 'playbackSession',
  log: 'log'
}

export const LOG_HOURS_TO_KEEP = 48

export function defaultDeviceSettings() {
  return {
    disableAutoRewind: false,
    enableAltView: true,
    allowSeekingOnMediaControls: false,
    jumpBackwardsTime: 10,
    jumpForwardTime: 10,
    enableMp3IndexSeeking: false,
    disableShakeToResetSleepTimer: false,
    shakeSensitivity: 'MEDIUM',
    lockOrientation: 'NONE',
    hapticFeedback: 'LIGHT',
    autoSleepTimer: false,
    autoSleepTimerStartTime: '22:00',
    autoSleepTimerEndTime: '06:00',
    sleepTimerLength: 900000, // 15 minutes
    autoSleepTimerAutoRewind: false,
    autoSleepTimerAutoRewindTime: 300000, // 5 minutes
    disableSleepTimerFadeOut: false,
    disableSleepTimerResetFeedback: false,
    enableSleepTimerAlmostDoneChime: false,
    languageCode: 'en-us',
    downloadUsingCellular: 'ALWAYS',
    streamingUsingCellular: 'ALWAYS',
    androidAutoBrowseLimitForGrouping: 100,
    androidAutoBrowseSeriesSequenceOrder: 'ASC'
  }
}

export function defaultDeviceData() {
  return { serverConnectionConfigs: [], lastServerConnectionConfigId: null, deviceSettings: defaultDeviceSettings(), lastPlaybackSession: null }
}

/**
 * Settings added in later app versions are missing (null) in data saved by older ones: fill them with the defaults.
 * Returns {data, changed}. Never touches a value that is set.
 */
export function normalizeDeviceData(raw) {
  const data = raw && typeof raw === 'object' ? { ...raw } : defaultDeviceData()
  let changed = !raw
  if (!Array.isArray(data.serverConnectionConfigs)) {
    data.serverConnectionConfigs = []
    changed = true
  }
  if (data.lastServerConnectionConfigId === undefined) {
    data.lastServerConnectionConfigId = null
    changed = true
  }
  if (data.lastPlaybackSession === undefined) {
    data.lastPlaybackSession = null
    changed = true
  }
  if (data.deviceSettings && typeof data.deviceSettings === 'object') {
    const defaults = defaultDeviceSettings()
    const settings = { ...data.deviceSettings }
    for (const key of Object.keys(defaults)) {
      if (settings[key] === null || settings[key] === undefined) {
        settings[key] = defaults[key]
        changed = true
      }
    }
    data.deviceSettings = settings
  } else {
    data.deviceSettings = defaultDeviceSettings()
    changed = true
  }
  return { data, changed }
}

/** Android's Base64 URL_SAFE | NO_WRAP of the UTF-8 bytes: '-' and '_', padding kept */
export function base64Id(text, btoaFn = globalThis.btoa) {
  return btoaFn(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_')
}

export function isPodcast(item) {
  return item.mediaType === 'podcast'
}

/** Which local files of a library item to test and how: every local file is asked about once */
export function localFileProbe(file) {
  return file.contentUrl && file.contentUrl.startsWith('content:') ? { contentUrl: file.contentUrl } : { path: file.absolutePath }
}

/**
 * Cleanup of one local library item once we know which of its local files still exist ({fileId: boolean}).
 * Returns {remove: true} for a local-only item (support removed in app 0.9.67), else {item, changed}.
 */
export function cleanLocalLibraryItem(item, exists) {
  if (item.serverConnectionConfigId === null || item.serverConnectionConfigId === undefined) return { remove: true }
  const out = { ...item, media: { ...item.media } }
  let changed = false
  const files = (item.localFiles || []).filter((f) => exists[f.id] !== false)
  if (files.length !== (item.localFiles || []).length) changed = true
  out.localFiles = files
  const hasFile = (id) => files.some((f) => f.id === id)
  if (isPodcast(item)) {
    const episodes = item.media.episodes
    if (episodes) {
      const kept = episodes.filter((ep) => ep.audioTrack != null && hasFile(ep.audioTrack.localFileId))
      if (kept.length !== episodes.length) changed = true
      out.media.episodes = kept
    }
  } else {
    const tracks = item.media.tracks
    if (tracks) {
      const kept = tracks.filter((t) => hasFile(t.localFileId))
      if (kept.length !== tracks.length) changed = true
      out.media.tracks = kept
    }
  }
  if (item.coverAbsolutePath) {
    const coverFile = files.find((f) => f.absolutePath === item.coverAbsolutePath)
    if (!coverFile) {
      out.coverAbsolutePath = null
      out.coverContentUrl = null
      changed = true
    }
  }
  return { item: out, changed }
}

/** Ids of local media progress to remove: ones the server's old bug renamed, with no local item, or a podcast episode that is gone */
export function staleLocalMediaProgressIds(allProgress, items) {
  const byId = new Map(items.map((i) => [i.id, i]))
  const remove = []
  for (const p of allProgress) {
    const item = byId.get(p.localLibraryItemId)
    if (!p.id.startsWith('local')) remove.push(p.id)
    else if (!item) remove.push(p.id)
    else if (isPodcast(item)) {
      if (!p.localEpisodeId) remove.push(p.id)
      else if (!(item.media.episodes || []).some((ep) => ep.id === p.localEpisodeId)) remove.push(p.id)
    }
  }
  return remove
}

export function oldLogIds(logs, nowMs, hours = LOG_HOURS_TO_KEEP) {
  const cutoff = nowMs - 3600000 * hours
  return logs.filter((l) => l.timestamp < cutoff).map((l) => l.id)
}

export function localMediaProgressId(localLibraryItemId, localEpisodeId) {
  return localEpisodeId ? `${localLibraryItemId}-${localEpisodeId}` : localLibraryItemId
}

/** A new local media progress for a local library item (fields linking it to the server item copied from the item) */
export function newLocalMediaProgress(item, { id, localEpisodeId = null, episodeId = null, duration, progress = 0, currentTime = 0, isFinished = false, ebookLocation = null, ebookProgress = null, lastUpdate, startedAt = 0, finishedAt = null }) {
  return {
    id,
    localLibraryItemId: item.id,
    localEpisodeId,
    duration,
    progress,
    currentTime,
    isFinished,
    ebookLocation,
    ebookProgress,
    lastUpdate,
    startedAt,
    finishedAt,
    serverConnectionConfigId: item.serverConnectionConfigId ?? null,
    serverAddress: item.serverAddress ?? null,
    serverUserId: item.serverUserId ?? null,
    libraryItemId: item.libraryItemId ?? null,
    episodeId
  }
}

/** LocalMediaProgress.updateIsFinished */
export function applyIsFinished(progress, finished, nowMs) {
  const p = { ...progress }
  if (p.isFinished !== finished) p.progress = finished ? 1.0 : 0.0
  if (finished) p.currentTime = 0.0
  p.isFinished = finished
  p.lastUpdate = nowMs
  p.finishedAt = finished ? nowMs : null
  return p
}

/** LocalMediaProgress.updateEbookProgress */
export function applyEbookProgress(progress, ebookLocation, ebookProgress, nowMs) {
  return { ...progress, lastUpdate: nowMs, ebookProgress, ebookLocation }
}

/** LocalMediaProgress.updateFromServerMediaProgress */
export function applyServerProgress(progress, server) {
  return {
    ...progress,
    isFinished: server.isFinished,
    progress: server.progress,
    currentTime: server.currentTime,
    ebookProgress: server.ebookProgress ?? null,
    ebookLocation: server.ebookLocation ?? null,
    duration: server.duration,
    lastUpdate: server.lastUpdate,
    finishedAt: server.finishedAt ?? null,
    startedAt: server.startedAt
  }
}

/** The audio tracks of a local item's media, as the same objects (a podcast's are its episodes') */
export function audioTracksOf(item) {
  if (isPodcast(item)) return (item.media.episodes || []).map((e) => e.audioTrack).filter(Boolean)
  return item.media.tracks || []
}

/** AbsDatabase.updateLocalTrackOrder: renumber the tracks 1.. in the order given. Returns {item, changed} (item is mutated). */
export function reorderTracks(item, order) {
  const tracks = audioTracksOf(item)
  let index = 1
  let changed = false
  for (const entry of order) {
    const track = tracks.find((t) => t.localFileId === entry.localFileId)
    if (!track) continue
    if (track.index !== index) changed = true
    track.index = index++
  }
  return { item, changed }
}

/** MediaItemHistory id of a progress: the server item when linked to one, else the local item */
export function mediaItemIdOf(p) {
  if (p.libraryItemId !== null && p.libraryItemId !== undefined) return p.episodeId ? `${p.libraryItemId}-${p.episodeId}` : p.libraryItemId
  return p.localEpisodeId ? `${p.localLibraryItemId}-${p.localEpisodeId}` : p.localLibraryItemId
}

export function syncEvent(currentTime, description, nowMs) {
  return { name: 'Sync', type: 'Sync', description, currentTime, serverSyncAttempted: false, serverSyncSuccess: null, serverSyncMessage: null, timestamp: nowMs }
}
