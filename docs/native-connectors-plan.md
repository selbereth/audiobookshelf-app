# Plan: native code as connectors only

Status: **draft for review. No code has changed yet.** Scope: Android first, iOS in a later pass.

## Goal

All app logic lives in JavaScript. The Android (and later iOS) code only does the work that has to be native, and
passes events and data to JS as fast as possible. Native code makes no decisions: it does not choose, retry, merge,
schedule, count or work out times.

Decisions already made:

- **Headless JS runs in a hidden web view.** Android Auto, a Pebble cold start, the widget, media buttons with the
  app closed and headless read-aloud all run the same JS logic, in a web view nobody sees. `TtsHeadless.kt` already
  does this for read-aloud, so we know the approach works on this app.
- **Android first.** iOS keeps its current native logic until a later pass (see "iOS later" below).
- **This document comes first.** Nothing is moved until it has been reviewed.

## Where things are now

About 16,900 lines of Kotlin. Most of it is logic, not connector code:

| Area | Files (lines) | Logic that should move to JS |
|---|---|---|
| Player service | `PlayerNotificationService.kt` (2228) | Session start and end, local vs. server choice, chapter and track math, progress checks, ended handling, about 800 lines of Android Auto browse tree (`onLoadChildren`, `onSearch`) |
| Player events | `PlayerListener.kt` (174) | Ignoring seek-caused pauses, rewind-on-resume time (`calcPauseSeekBackTime`), sync calls |
| Media inputs | `MediaSessionCallback.kt` (310), `MediaSessionPlaybackPreparer.kt` (93) | Media button click counting, speed cycling, play-from-search, play-from-id |
| Android Auto data | `MediaManager.kt` (1028), `BrowseTree.kt`, `data/Library*.kt` | Loading libraries, shelves, series, authors, collections; search with Levenshtein matching; saved playback rate |
| Server API | `server/ApiHandler.kt` (840) | Every REST call, token refresh, error handling |
| Progress sync | `MediaProgressSyncer.kt` (360), `MediaEventManager.kt` (132) | Sync interval, local vs. server progress, failure alerts, item history |
| Sleep timer | `SleepTimerManager.kt` (544) | Manual/auto/chapter-end timers, fade-out, shake-to-reset, rewind after auto timer |
| Database | `DbManager.kt` (405), `plugins/AbsDatabase.kt` (591) | Schema, cleanup of stale items and progress, download queue checks, progress merging, "mark finished" rules |
| Downloads | `DownloadItemManager.kt` (794), `InternalDownloadManager.kt` (203), `FolderScanner.kt` (312), `IncompleteDownloadCleanup.kt`, `plugins/AbsDownloader.kt` (272) | Queue, concurrency, retries, auth-error parking, finalization, space checks, building local items from scans, expiry rules |
| Read-aloud | `TtsController.kt` (472), `TtsService.kt` (413), `TtsHeadless.kt` (279), `plugins/AbsTts.kt` | Sentence queue, refill, skip, seek, read-aloud sleep timer, headless bridge |
| Pebble | `PebbleController.kt` (312) | Command handling, status building, "start most recent book", volume steps |
| Device state | `DeviceManager.kt` (228), `data/DeviceClasses.kt` (254) | Settings defaults, server version checks, last session, widget update decisions |
| Data models | `data/*.kt`, `models/*.kt` (~2000) | Jackson models and their helper methods; native should mostly pass JSON through |
| Cast | `CastManager.kt`, `CastPlayer.kt` (1028), `CastTimeline*.kt` | `CastPlayer` is a Player adapter (connector code, stays). Queue and metadata building moves to JS. |

JS today: `plugins/capacitor/*.js` are thin wrappers, Vuex in `store/`, and read-aloud session logic already in
`utils/tts/` (also bundled headless by `npm run build:tts-headless`).

## Target architecture

```
                 +---------------------- JS core (one copy, one place) ----------------------+
                 | player session | progress sync | sleep timer | downloads queue | db schema |
                 | server API     | Android Auto browse | media buttons | read-aloud | pebble  |
                 +-------------------------------^-------------------------------------------+
                                                 | one message bridge: calls down, events up
   +---------------------------------------------v---------------------------------------------+
   |                              Native connectors (Kotlin)                                   |
   | ExoPlayer | MediaSession/MediaBrowser | notification | KV store | HTTP transfer | files/SAF |
   | TextToSpeech engine | sensors | vibrate/chime | widget render | Pebble transport | Cast SDK |
   | alarms/WorkManager wakeups | Keystore | network state                                     |
   +-------------------------------------------------------------------------------------------+
```

### One JS core, always in the hidden web view (recommended)

The core logic runs in **one place only**: a hidden web view (`CoreHost`) that the player service starts and
keeps for as long as the process lives. The visible app web view is a UI client of the core: it sends commands and
gets state and events through the same native bridge.

Why not "run the core in the app web view, and in a hidden one only when the app is closed"? Then two copies of the
logic can be alive at once, and every hand-over (app opens while Android Auto is playing, Pebble starts the book and
then the screen opens) has to move live state from one to the other. `TtsHeadless.handOver()` does that today for
read-aloud and is the most fragile part of it. With one core there is no hand-over.

Cost: a second web view while the UI is open (roughly 30 to 50 MB), and one extra hop (UI web view, native, core web
view) on each UI command, which is well under a frame.

**Alternative for review:** keep the core in the UI web view and use the hidden one only when there is no UI, with a
hand-over each way. Less memory, more edge cases. I recommend the single core.

### The core must not touch the DOM

The core is plain JS: no `window.document`, no Vue, no Vuex. It uses only timers, `Promise`, `JSON` and the bridge.
This keeps it testable in Node (unit tests with mocks of the bridge) and lets iOS later run the same bundle in
JavaScriptCore, which has no DOM.

The UI keeps Vuex for display state. Vuex modules subscribe to core events instead of plugin events.

### Bridge protocol

One bridge, used by every connector, replacing the hand-written `NativeTts` shim:

- **Calls down** (JS to native): `native.call(connector, method, args) -> Promise<result>`. JSON in, JSON out.
- **Events up** (native to JS): `native.on(connector, event, handler)`. Native sends every event as soon as it
  happens, with a timestamp taken when it happened (so JS can count media button clicks or measure pause length
  correctly even if delivery is late).
- **Calls up** (native asks JS and waits): needed where Android expects an answer, for example Android Auto
  `onLoadChildren` (uses `result.detach()`, so waiting is allowed) and `onGetRoot`. Native sends a request id; JS
  replies; native times out with an empty answer after a few seconds.
- **Buffering:** while the core is starting (or after it has crashed and is restarting), native queues events and
  replays them in order once the core says it is ready. Playback itself never waits for JS: ExoPlayer keeps playing
  on its own.

The UI web view talks to the core through the same native relay (`CoreHost.forwardToCore` /
`forwardToUi`), so a Capacitor plugin call from the UI becomes a core call.

### What stays native: the connector list

Each connector is a small Kotlin class with no logic beyond calling the Android API and turning the result into JSON.

| Connector | Calls down (from JS) | Events up (to JS) |
|---|---|---|
| `player` (ExoPlayer, Cast) | `load(tracks, startIndex, positionMs, rate, metadata)`, `play`, `pause`, `seek(trackIndex, positionMs)`, `setRate`, `setVolume`, `stop`, `useCast(bool)` | `isPlaying`, `state` (buffering/ready/ended), `position` ticks while playing, `trackChanged`, `error`, `castAvailable` |
| `mediaSession` | `setMetadata`, `setPlaybackState`, `setCustomActions`, `setQueue` | `play`, `pause`, `skip*`, `seekTo`, `customAction`, `mediaButton(keyCode, action, time)`, `playFromMediaId`, `playFromSearch` |
| `browse` (Android Auto) | none | calls up: `getRoot(clientPackage)`, `loadChildren(parentId)`, `search(query)`; native turns the JSON nodes into `MediaItem`s |
| `notification` | `show(content)`, `hide` | `tapped` |
| `store` (key-value, replaces Paper schema code) | `get`, `put`, `delete`, `list(collection)` | none |
| `secure` (Keystore) | `get`, `put`, `delete` | none |
| `http` | `request(method, url, headers, body)`; needed because the hidden web view's origin may fail the server's CORS check (the UI uses `http://localhost`; see Phase 0) | none |
| `transfer` (downloads) | `start(id, url, headers, destination, resumeFrom)`, `cancel(id)` | `progress(id, bytes, total)`, `done(id)`, `failed(id, httpStatus, message)` |
| `files` / SAF | `list`, `stat`, `move`, `delete`, `freeSpace`, `pickFolder`, `probeAudio(uri)` (duration and tags) | none |
| `tts` (TextToSpeech engine) | `speak(utteranceId, text, rate, pitch, voice)`, `stop`, `voices` | `start`, `range(word)`, `done`, `error` |
| `sensors` | `shake.enable/disable(threshold)` | `shake` |
| `feedback` | `vibrate(pattern)`, `chime` | none |
| `widget` | `render(title, author, coverUrl, isPlaying)` | `tapped(action)` |
| `pebble` | `send(watch, dict)` | `opened(watch)`, `message(watch, dict)` |
| `wake` | `schedule(id, atMs)` (exact alarm while playing, WorkManager otherwise), `cancel(id)` | `wake(id)` |
| `system` | `network`, `deviceInfo`, `appVersion` | `networkChanged`, `appForeground/Background` |

Services (`PlayerNotificationService`, `TtsService`, `DownloadService`, `PebbleListenerService`) stay because
Android needs them to keep the process and the foreground notification alive. Their bodies shrink to: start or stop
foreground, hold the connector, start `CoreHost`.

## Risks to prove before moving code (Phase 0)

1. **Timers in a hidden web view with the screen off.** Chromium can throttle timers in pages that are not shown.
   The sleep timer and the 15-second sync must still fire. Plan: the `wake` connector and `player` position ticks
   drive time-critical work from native, so JS does not depend on `setTimeout` for anything that matters. Measure
   on the Pixel: screen off, one hour, a manual sleep timer and sync log, compared with today.
2. **Start-up time.** Android Auto and a Pebble cold start wait for the core to load. The `tts-headless` page loads
   in well under a second today; measure the core bundle the same way. Native answers `onGetRoot` immediately with
   a fixed root, so only `loadChildren` waits.
3. **CORS.** The hidden page is loaded from `file://` today (origin `null`). Load it through `WebViewAssetLoader`
   on `http://localhost` like the UI, and check whether direct `fetch` to the server works; if not, use the `http`
   connector for all server calls.
4. **Process death and core crash.** If the core web view's renderer dies, native restarts `CoreHost`, replays
   buffered events and keeps playing. Test by killing the renderer (`WebView` `onRenderProcessGone`).
5. **Battery restrictions.** Starting the core from the background is the same as starting the player service from
   the background today (AGENTS.md: foreground service limits, audio focus on Android 16). No new limits, but test
   the Pebble cold start again.

Phase 0 ends with a short note of the measurements and a go/no-go.

## Phases

Each phase is its own branch off `master`, merged with `--no-ff` once built and tested on the emulator and Pixel, as
AGENTS.md requires. Every phase leaves the app working; old native code is deleted in the same phase that replaces
it, not later.

| # | Branch | What moves | Native left behind |
|---|---|---|---|
| 0 | `core-spike` | Prototype `CoreHost` and bridge; measurements above | nothing merged unless go |
| 1 | `core-host` | `CoreHost` (hidden web view started by the player service), bridge protocol, core bundle built with esbuild like `tts-headless` (`npm run build:core`), Node unit-test setup for the core | bridge only |
| 2 | `core-store` | DB schema and rules from `DbManager` and `AbsDatabase` (cleanup, queue checks, progress merging, mark finished). One-time migration: native reads the existing Paper data with the old classes and hands it to JS as JSON; those classes are deleted one release later | `store`, `secure` connectors |
| 3 | `core-api-sync` | `ApiHandler`, token refresh, `MediaProgressSyncer`, `MediaEventManager` | `http` connector |
| 4 | `core-player` | Session preparation (local vs. server, track list and URLs, Cast queue), chapter and track math, seek-pause filtering, rewind on resume, ended handling, speed persistence, progress checks | `player`, `notification` connectors; `PlayerNotificationService` reduced to service shell |
| 5 | `core-sleep-timer` | `SleepTimerManager` and shake handling | `sensors`, `feedback`, `wake` |
| 6 | `core-media-inputs` | `MediaSessionCallback`, `MediaSessionPlaybackPreparer`, media button click counting, custom actions | `mediaSession` connector |
| 7 | `core-auto-browse` | `MediaManager`, `BrowseTree`, `onLoadChildren`, `onSearch`, library models used only for Auto | `browse` connector (JSON to `MediaItem`) |
| 8 | `core-downloads` | `DownloadItemManager` queue/retry/finalization, `FolderScanner`, expiry rules from `IncompleteDownloadCleanup`, filename cleaning from `AbsDownloader` | `transfer`, `files` connectors; WorkManager job only wakes the core |
| 9 | `core-tts` | `TtsController` queue, refill, skip, seek, read-aloud sleep timer; `TtsHeadless` removed (the core host replaces it) | `tts` connector, `TtsService` shell |
| 10 | `core-pebble` | `PebbleController`; message keys and states move to a JS constant file (still kept in sync with `selbershelf-pebble`) | `pebble` connector |
| 11 | `core-widget-device` | Widget state decisions, `DeviceManager` logic, settings defaults | `widget`, `system` connectors |
| 12 | `core-cleanup` | Delete unused Jackson models and helpers; check that no `if` in native code makes an app decision | none |

Order reasoning: storage and API first because everything else reads them; the player before the sleep timer,
media inputs and Auto because they all drive the player; read-aloud and Pebble late because they cross into
`TtsHeadless` and the watch repo.

Rough estimate (a guess, to check after Phase 1): Android Kotlin goes from about 16,900 lines to about 5,000 to
6,000, mostly services, connectors and the Cast player adapter.

### Branch conflicts with `tts`, `add-auto-delete`, `pebble`

This refactor touches every native file those branches change. To keep them mergeable:

- Merge the open feature branches into `master` before the phase that touches their area (auto-delete before
  Phase 8, tts before Phase 9, pebble before Phase 10), or port their logic into the core in that phase.
- `utils/autoDelete.js` already puts auto-delete logic in JS; Phase 8 keeps it that way.

## Testing

- **Core unit tests in Node** (new): each phase adds tests for the logic it moves, run with a fake bridge. Today
  most of this logic has no tests.
- **Emulator** for each phase: the flows in that phase (play/pause/seek/sleep timer/downloads/Auto via the Desktop
  Head Unit/Pebble debug receiver).
- **Pixel** for anything with timing, audio focus or a cold start (Phases 0, 4, 5, 6, 9, 10). Results from the
  emulator are not claimed for the Pixel.
- Same rule as AGENTS.md: reproduce, change, re-run the same check.

## iOS later

iOS has about 7,600 lines of Swift with the same kinds of logic (`AudioPlayer.swift`, `ApiClient.swift`,
`Database.swift`, `AudioPlayerSleepTimer.swift`, `PlayerProgress.swift`). Once Android is done:

- Run the same core bundle in JavaScriptCore (no DOM needed, which is why the core avoids it), started by the app
  delegate or the audio session.
- JavaScriptCore has no `fetch` or timers: the `http` and `wake` connectors cover both.
- Write the same connectors in Swift; the core code does not change.

Until then iOS keeps working as it does now, through the existing plugin calls. The JS wrappers in
`plugins/capacitor/` pick the core on Android and the old plugins on iOS.

## Questions for review

1. **Single core in the hidden web view, or hand-over between UI and hidden web view?** I recommend the single core.
2. **Storage migration:** is a one-time migration from Paper (keeping the old classes for one release) acceptable,
   or should the core keep reading the Paper format through a native adapter for longer?
3. **Phase order:** any phase you want sooner (for example sleep timer or Pebble)?
4. **Feature branches:** merge `tts`, `add-auto-delete` and `pebble` into `master` first, or keep them separate and
   port their logic during the refactor?
