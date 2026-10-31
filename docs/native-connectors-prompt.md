I want a big refactor of this app (audiobookshelf-app). No logic should live in the Android or iOS code: all of it
moves to JS. Native code should only do the work that has to be native and pass events and data to JS as fast as
possible. Native makes no decisions: it does not choose, retry, merge, schedule, count or work out times. It is
connectors only.

Read `AGENTS.md` first and follow it: one branch per phase off `master`, merged with `--no-ff`; build and test on the
emulator, then the Pixel; say honestly what you checked where. You have the Android SDK, the emulator, the Pixel and the
Pebble setup (`selbershelf-pebble` repo) on this machine.

## Decisions already made

- **Android first.** iOS keeps its current native logic until a later pass. The JS wrappers in `plugins/capacitor/`
  use the new core on Android and the old plugins on iOS.
- **Headless JS runs in a hidden web view.** Android Auto, a Pebble cold start, the widget, media buttons with the app
  closed and headless read-aloud must all run the same JS logic in a web view nobody sees. `tts/TtsHeadless.kt` and
  `utils/tts/headless/` already do this for read-aloud: use them as the starting point.
- **Plan first, then phases.** Build Phase 0 below, report the measurements, and stop for my go/no-go before Phase 1.

## Where the logic is now (about 16,900 lines of Kotlin)

| Area | Files | Logic to move to JS |
|---|---|---|
| Player service | `player/PlayerNotificationService.kt` (2228) | session start and end, local vs. server choice, chapter and track math, progress checks, ended handling, about 800 lines of Android Auto browse tree (`onLoadChildren`, `onSearch`) |
| Player events | `player/PlayerListener.kt` | ignoring seek-caused pauses, rewind on resume (`calcPauseSeekBackTime`), sync calls |
| Media inputs | `player/MediaSessionCallback.kt`, `player/MediaSessionPlaybackPreparer.kt` | media button click counting, speed cycling, play from search, play from id |
| Android Auto data | `media/MediaManager.kt` (1028), `player/BrowseTree.kt`, `data/Library*.kt` | libraries, shelves, series, authors, collections, search with Levenshtein, saved playback rate |
| Server API | `server/ApiHandler.kt` (840) | every REST call, token refresh, error handling |
| Progress sync | `media/MediaProgressSyncer.kt`, `media/MediaEventManager.kt` | sync interval, local vs. server progress, failure alerts, item history |
| Sleep timer | `managers/SleepTimerManager.kt` (544) | manual, auto and chapter-end timers, fade-out, shake to reset, rewind after auto timer |
| Database | `managers/DbManager.kt`, `plugins/AbsDatabase.kt` (591) | schema, cleanup of stale items and progress, download queue checks, progress merging, "mark finished" rules |
| Downloads | `managers/DownloadItemManager.kt` (794), `InternalDownloadManager.kt`, `device/FolderScanner.kt`, `IncompleteDownloadCleanup.kt`, `plugins/AbsDownloader.kt` | queue, concurrency, retries, auth-error parking, finalization, space checks, building local items from scans, expiry rules |
| Read-aloud | `tts/TtsController.kt`, `tts/TtsService.kt`, `tts/TtsHeadless.kt`, `plugins/AbsTts.kt` | sentence queue, refill, skip, seek, read-aloud sleep timer, headless bridge |
| Pebble | `pebble/PebbleController.kt` | command handling, status building, start most recent book, volume steps |
| Device state | `device/DeviceManager.kt`, `data/DeviceClasses.kt` | settings defaults, server version checks, last session, widget update decisions |
| Data models | `data/*.kt`, `models/*.kt` (~2000) | Jackson models and helpers; native should mostly pass JSON through |
| Cast | `player/CastManager.kt`, `player/CastPlayer.kt`, `player/CastTimeline*.kt` | `CastPlayer` is a Player adapter and stays; queue and metadata building moves to JS |

## Target design

### One JS core, always in the hidden web view

The logic runs in one place only: a hidden web view (`CoreHost`) that the player service starts and keeps for as long
as the process lives. The visible app web view is a client of the core: it sends commands and gets state and events
through a native relay. There is no hand-over between two copies of the logic (the hand-over in `TtsHeadless.handOver()`
is the most fragile part of read-aloud today). The cost is a second web view while the UI is open (about 30 to 50 MB).
If Phase 0 shows that cost is too high, tell me before choosing the other design (core in the UI web view, hidden one
only when there is no UI, with a hand-over each way).

### The core does not touch the DOM

The core is plain JS: no `document`, no Vue, no Vuex. Only timers, `Promise`, `JSON` and the bridge. It must be
unit-testable in Node with a fake bridge, and later run in JavaScriptCore on iOS. The UI keeps Vuex for display state,
fed by core events. Build it with esbuild like `npm run build:tts-headless` (add `npm run build:core` to `npm run sync`).

### Bridge protocol (one bridge for every connector; it replaces the `NativeTts` shim)

- Calls down: `native.call(connector, method, args) -> Promise<result>`, JSON in and out.
- Events up: `native.on(connector, event, handler)`. Native sends each event as soon as it happens, with the time it
  happened (so JS can count media button clicks or measure pause length correctly even if delivery is late).
- Calls up (native asks JS and waits): Android Auto `loadChildren` (use `result.detach()`) and `search`. Native answers
  `onGetRoot` at once with a fixed root, and times out with an empty answer after a few seconds.
- Buffering: while the core starts or restarts after a crash, native queues events and replays them in order once the
  core says it is ready. Playback never waits for JS: ExoPlayer keeps playing on its own.

### What stays native: the connectors

Each connector is a small Kotlin class that calls the Android API and turns the result into JSON, with no app logic.

| Connector | Calls down | Events up |
|---|---|---|
| `player` (ExoPlayer, Cast) | `load(tracks, startIndex, positionMs, rate, metadata)`, `play`, `pause`, `seek(trackIndex, positionMs)`, `setRate`, `setVolume`, `stop`, `useCast` | `isPlaying`, `state`, `position` ticks while playing, `trackChanged`, `error`, `castAvailable` |
| `mediaSession` | `setMetadata`, `setPlaybackState`, `setCustomActions`, `setQueue` | `play`, `pause`, `skip*`, `seekTo`, `customAction`, `mediaButton(keyCode, action, time)`, `playFromMediaId`, `playFromSearch` |
| `browse` (Android Auto) | none | calls up: `getRoot`, `loadChildren(parentId)`, `search(query)`; native turns JSON nodes into `MediaItem`s |
| `notification` | `show`, `hide` | `tapped` |
| `store` (key-value; replaces the Paper schema code) | `get`, `put`, `delete`, `list(collection)` | none |
| `secure` (Keystore) | `get`, `put`, `delete` | none |
| `http` | `request(method, url, headers, body)` | none |
| `transfer` (downloads) | `start(id, url, headers, destination, resumeFrom)`, `cancel` | `progress`, `done`, `failed(id, httpStatus, message)` |
| `files` / SAF | `list`, `stat`, `move`, `delete`, `freeSpace`, `pickFolder`, `probeAudio(uri)` | none |
| `tts` (TextToSpeech engine) | `speak(utteranceId, text, rate, pitch, voice)`, `stop`, `voices` | `start`, `range`, `done`, `error` |
| `sensors` | `shake.enable/disable(threshold)` | `shake` |
| `feedback` | `vibrate(pattern)`, `chime` | none |
| `widget` | `render(title, author, coverUrl, isPlaying)` | `tapped(action)` |
| `pebble` | `send(watch, dict)` | `opened(watch)`, `message(watch, dict)` |
| `wake` | `schedule(id, atMs)` (exact alarm while playing, WorkManager otherwise), `cancel` | `wake(id)` |
| `system` | `network`, `deviceInfo`, `appVersion` | `networkChanged`, `appForeground/Background` |

The services (`PlayerNotificationService`, `TtsService`, `DownloadService`, `PebbleListenerService`) stay, because
Android needs them for the process and the foreground notification. Their bodies shrink to: start or stop foreground,
hold the connector, start `CoreHost`.

## Phase 0: prove the risky parts (branch `core-spike`)

Build a minimal `CoreHost` and bridge, then measure:

1. **Timers with the screen off.** Chromium can throttle timers in hidden pages. On the Pixel, screen off for an hour:
   does a JS timer driven by the `wake` connector and by `player` position ticks fire on time (a sleep timer and a
   15-second sync log), compared with today?
2. **Start-up time** of the core page from a stopped process: started by Android Auto (Desktop Head Unit) and by a
   Pebble cold start (use the debug `PebbleDebugReceiver` and the real watch).
3. **CORS.** The hidden page loads from `file://` today (origin `null`). Load it through `WebViewAssetLoader` on
   `http://localhost` like the UI and check whether `fetch` to the server works. If not, all server calls go through
   the `http` connector.
4. **Renderer crash.** Kill the core renderer (`onRenderProcessGone`): does native restart `CoreHost`, replay buffered
   events and keep playing?
5. **Memory** of the second web view while the UI is open.
6. **Background start limits** are unchanged (see AGENTS.md on foreground services and Android 16 audio focus):
   check the Pebble cold start again.

Write the measurements in a short note, then stop and ask me for go/no-go. Nothing from the spike is merged unless I
say go.

## Later phases (one branch each, each leaves the app working and deletes the native code it replaces)

1. `core-host`: `CoreHost`, bridge, core bundle, Node unit-test setup.
2. `core-store`: DB schema and rules from `DbManager` and `AbsDatabase`. One-time migration: native reads the existing
   Paper data with the old classes and hands it to JS as JSON. Leaves `store` and `secure`.
3. `core-api-sync`: `ApiHandler`, token refresh, `MediaProgressSyncer`, `MediaEventManager`. Leaves `http`.
4. `core-player`: session preparation, Cast queue, chapter and track math, seek-pause filtering, rewind on resume,
   ended handling, speed persistence. Leaves `player`, `notification`.
5. `core-sleep-timer`: `SleepTimerManager`, shake. Leaves `sensors`, `feedback`, `wake`.
6. `core-media-inputs`: `MediaSessionCallback`, `MediaSessionPlaybackPreparer`, click counting. Leaves `mediaSession`.
7. `core-auto-browse`: `MediaManager`, `BrowseTree`, `onLoadChildren`, `onSearch`. Leaves `browse`.
8. `core-downloads`: download queue, `FolderScanner`, expiry rules, filename cleaning. Leaves `transfer`, `files`.
9. `core-tts`: `TtsController` logic; `TtsHeadless` removed (the core host replaces it). Leaves `tts`.
10. `core-pebble`: `PebbleController`; message keys and states in a JS constants file, still in sync with
    `selbershelf-pebble`. Leaves `pebble`.
11. `core-widget-device`: widget and `DeviceManager` logic. Leaves `widget`, `system`.
12. `core-cleanup`: delete unused Jackson models; check no native `if` makes an app decision.

Rough guess to check after Phase 1: Android Kotlin drops from about 16,900 lines to about 5,000 to 6,000.

For each phase: add Node unit tests for the logic moved; test the phase's flows on the emulator; test anything with
timing, audio focus or a cold start on the Pixel (phases 4, 5, 6, 9, 10). Reproduce, change, re-run the same check.

## Questions to ask me before the phase they affect

1. Before Phase 2: is a one-time Paper migration (old classes kept for one release) fine, or should the core read the
   Paper format through a native adapter for longer?
2. Before Phases 8 to 10: merge `tts`, `add-auto-delete` and `pebble` into `master` first, or port their logic into
   the core during the refactor? This refactor touches every native file they change.
3. Any phase I want sooner?

Do not commit, push or merge without my say-so in the session.
