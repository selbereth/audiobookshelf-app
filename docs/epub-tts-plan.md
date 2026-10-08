# EPUB Text-to-Speech — Feature Overview & Implementation Plan

Status: **Proposal / design doc**
Scope: Audiobookshelf mobile app (`audiobookshelf-app`) — Android + iOS
Reader affected: `components/readers/EpubReader.vue` (epub.js `0.3.88`)

---

## 1. Goal

Let users listen to any EPUB in their library using text-to-speech, with the
same "it just keeps playing" experience they get from audiobooks:

- Starts from where they are reading (or from any paragraph they pick).
- **Keeps playing with the screen off / phone locked, for hours.**
- Lock-screen, notification, Bluetooth and headphone controls.
- Highlights the sentence being read and follows along in the reader.
- Saves progress back to the same `ebookLocation` (CFI) the reader already
  uses, so reading and listening share one position across devices.

### Hard requirement

> TTS **must** keep playing while the screen is off.

This requirement drives the whole architecture (see §3).

---

## 2. Feature list

### 2.1 MVP

| Feature | Description |
|---|---|
| Play / pause | TTS button in the reader toolbar (`components/readers/Reader.vue`). |
| Start from current page | Begins at the first sentence of the visible page (`rendition.currentLocation().start.cfi`). |
| Background playback | Continues with the screen locked; app backgrounded. |
| Lock-screen / notification controls | Play, pause, skip back/forward (sentence). |
| Bluetooth / headset buttons | Play/pause, next/previous. |
| Sentence highlighting | Current sentence highlighted via `rendition.annotations.highlight(cfi)`. |
| Auto page-turn | Reader follows the spoken sentence (`rendition.display(cfi)`). |
| Speech rate | Adjustable speed (e.g. 0.5×–3×). |
| Progress sync | Current sentence's CFI saved as `ebookLocation` (local DB + server). |
| Audio focus | Pause for calls/navigation, duck or pause for other apps, pause on headphone unplug. |

### 2.2 v2

| Feature | Description |
|---|---|
| Voice picker | List installed device voices per language. |
| Pitch | Adjustable pitch. |
| "Start from here" | Long-press / tap a paragraph to start reading there. |
| Skip by paragraph / chapter | In addition to sentence skip. |
| Sleep timer | Timed or "end of chapter"; reuse the existing sleep-timer UX. |
| Per-book overrides | Voice/language override for books with wrong `dc:language`. |
| Word-level highlighting (iOS) | Using `willSpeakRangeOfSpeechString`. |
| Content filters | Toggle reading of image alt text, footnotes, etc. |

### 2.3 Later / optional

- Server-rendered neural TTS (Piper / Kokoro / cloud) as an alternative engine.
- Android Auto / CarPlay surface for TTS sessions.
- Pronunciation dictionary (user-defined replacements).

---

## 3. Architecture decision

### 3.1 Options considered

| Option | Screen-off? | Verdict |
|---|---|---|
| Web Speech API (`speechSynthesis`) in the WebView | ❌ Stops when WebView is suspended; unreliable on Android WebView | Rejected |
| `@capacitor-community/text-to-speech` plugin, queue driven from JS | ⚠️ Current utterance finishes, but the **JS queue** that sends the next line is throttled/suspended when locked (iOS suspends the WebKit content process; Android may freeze the WebView without a foreground service). No media session / lock-screen controls. | Rejected |
| Pre-render TTS to audio files and play through existing audio player | ✅ | Rejected — generating files is wasteful, slow to start, and fragile across TTS engines |
| **Native TTS engine + native queue + native media session (custom `AbsTts` plugin)** | ✅ | **Chosen** — this is how dedicated TTS readers work |

### 3.2 Chosen design: "Option A"

```
┌──────────────────────── WebView (Nuxt / Vue) ────────────────────────┐
│ EpubReader.vue                                                        │
│   epub.js book ──► SentenceStream (generator) ──► ChunkSender ───────┼──┐
│        ▲                                                              │  │ chunks
│        │ highlight / display(cfi) ◄── onSentence(id) ◄────────────────┼──┼──┐
└────────┼──────────────────────────────────────────────────────────────┘  │  │
         │                                                                 ▼  │ events
┌────────┴────────────────────── Native (AbsTts plugin) ──────────────────────┴┐
│  SentenceStore (all received sentences, indexed by id)                       │
│  Feeder: keeps 10–20 sentences queued in the engine, refills on "done"       │
│  Engine: Android TextToSpeech  |  iOS AVSpeechSynthesizer                    │
│  Media session: notification + lock screen + BT buttons + audio focus        │
│  Progress: saves current sentence's CFI (local DB + server)                  │
│  Android: foreground service (mediaPlayback) + partial wake lock             │
│  iOS: AVAudioSession .playback (UIBackgroundModes: audio already enabled)    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** once sentences are in native memory, playback never depends
on JavaScript. JS is only needed to *produce* text (while the app is in the
foreground) and to *display* highlights (when the screen is on).

The app already does the platform plumbing for audiobooks — Android
`PlayerNotificationService.kt` runs a `mediaPlayback` foreground service and
iOS declares `UIBackgroundModes: audio` in `ios/App/App/Info.plist` — so the
TTS service follows established patterns in this codebase.

---

## 4. Text pipeline (JavaScript)

### 4.1 Sentence stream

A generator walks the book and yields sentences one at a time:

1. Iterate `book.spine` from the start position's spine index.
2. Load each section: `section.load(book.load.bind(book))` → DOM document.
3. Walk block elements in document order: `p`, `h1`–`h6`, `li`, `blockquote`,
   `dd`, `dt`, `figcaption`, `td` (and text-bearing `div`s without block children).
4. Skip non-spoken content:
   - footnote references (`epub:type="noteref"`), footnote bodies
     (`epub:type="footnote" | "endnote"`, `aside`)
   - `<rt>` / `<rp>` ruby annotations
   - page-break markers (`epub:type="pagebreak"`)
   - `script`, `style`, hidden elements
   - image alt text (optional, setting)
5. Split each block's text into sentences with
   `Intl.Segmenter(lang, { granularity: 'sentence' })`, where `lang` comes
   from `book.packaging.metadata.language` (with per-book override).
6. For each sentence, build a DOM `Range` and compute its CFI with
   `section.cfiFromRange(range)`.
7. Yield `{ id, text, cfi, spine }` where `id` is a monotonically increasing
   integer for this stream.

**Long-sentence guard:** Android's `TextToSpeech.getMaxSpeechInputLength()` is
~4000 chars. Any "sentence" over a safe limit (e.g. 1000 chars) is further split
at `;`, `,`, then whitespace, each piece getting its own sub-range CFI.

### 4.2 Chunking (not chapters)

Sentences are batched into **fixed-size chunks**, independent of chapter
boundaries, so a single enormous chapter never becomes one giant bridge message
or one long main-thread stall.

- Chunk boundary: every **N sentences (e.g. 50)** or **~4–8 KB** of text,
  whichever comes first.
- A chunk may span the end of one chapter and the start of the next; a huge
  chapter becomes many chunks. Chapter info is metadata (`spine`) on each
  sentence.
- **First chunk is small** (≈3–5 sentences) so speech starts almost instantly.
- Between chunks the producer yields to the event loop (`setTimeout(0)` /
  `requestIdleCallback`) so the reader stays responsive.

Chunk message:

```js
{
  streamId: 3,          // increments on every reset/seek
  seq: 17,              // chunk sequence number within the stream
  sentences: [
    { id: 4210, text: "It was a bright cold day in April.", cfi: "epubcfi(/6/14!/4/2/1:0)", spine: 5 },
    ...
  ],
  done: false           // true on the final chunk of the book
}
```

### 4.3 Keeping native ahead (screen-off safety)

- **Eager streaming (primary):** while the app is in the foreground, JS keeps
  producing and sending chunks back-to-back until `done: true`. A typical novel
  is 0.5–1 MB of text — trivial for native memory — and finishes streaming in
  seconds. By the time the user locks the phone, native has the whole book.
- **Pull fallback:** native emits `needMore({ streamId, lastSeq })` when fewer
  than ~2 chunks of unspoken sentences remain and the stream isn't `done`.
  On Android this is usually answerable even while locked (foreground service
  keeps the process alive); on iOS it's answered when the app returns to the
  foreground. Producer resumes from `lastSeq + 1`.
- Native de-duplicates by `(streamId, seq)` and ignores chunks from stale streams.

### 4.4 Following along (screen on)

- Native emits `sentence({ id, cfi })` as each sentence starts.
- JS removes the previous highlight and adds a new one with
  `rendition.annotations.highlight(cfi)`.
- If the CFI is outside the visible range, `rendition.display(cfi)`
  (respecting a "follow along" toggle so the user can browse freely).
- On app resume (`App` `resume` / `appStateChange`), JS calls
  `AbsTts.getState()` and jumps the reader to the current sentence.

---

## 5. Native plugin: `AbsTts`

Lives alongside the existing plugins:

- Android: `android/app/src/main/java/com/audiobookshelf/app/plugins/AbsTts.kt`
  (registered in `MainActivity.kt` next to `AbsAudioPlayer` etc.)
- iOS: `ios/App/App/plugins/AbsTts.swift`
  (registered in `MyViewController.swift` via `registerPluginInstance`)
- JS wrapper: `plugins/capacitor/AbsTts.js` (exported from `plugins/capacitor/index.js`)

### 5.1 JS → native API

| Method | Purpose |
|---|---|
| `start({ libraryItemId, localLibraryItemId?, title, author, coverUrl?, lang, voiceId?, rate, pitch, streamId })` | Create a TTS session, start the service/media session. Playback begins when the first chunk arrives. |
| `appendChunk(chunk)` | Add a chunk of sentences (see §4.2). |
| `play()` / `pause()` / `stop()` | Transport. `stop()` tears down the service. |
| `skip({ by: 'sentence' \| 'paragraph', count })` | Relative skip within received sentences. |
| `seekToSentence({ id })` | Jump to a sentence already in the store. |
| `reset({ streamId })` | Clear the store (used for "start from here" / chapter jump to text not yet received). |
| `setRate({ rate })` / `setPitch({ pitch })` / `setVoice({ voiceId })` | Clears the engine queue and refills from the current sentence. |
| `getVoices({ lang? })` | Installed voices (id, name, lang, quality, network-required). |
| `getState()` | `{ playing, currentId, currentCfi, streamId, lastSeq, bufferedCount }` |
| `setSleepTimer({ ms \| endOfChapter })` / `cancelSleepTimer()` | Sleep timer. |

### 5.2 Native → JS events

| Event | Payload |
|---|---|
| `sentence` | `{ id, cfi, spine }` — a sentence started |
| `word` (iOS, optional) | `{ id, start, length }` — character range within the sentence |
| `state` | `{ playing, reason? }` — e.g. paused by audio focus loss |
| `needMore` | `{ streamId, lastSeq }` |
| `ended` | Reached the end of the book (`done` received and queue drained) |
| `error` | `{ code, message }` (engine unavailable, voice missing, etc.) |

### 5.3 Feeder loop (both platforms)

```
store: [Sentence]           // everything received, in order
cursor: index of current sentence
engineQueue: ids handed to the engine (window of 10–20)

onChunk(chunk):
  if chunk.streamId != currentStreamId: ignore
  if seen(chunk.seq): ignore
  store.append(chunk.sentences)
  if playing and engineQueue is short: refill()

refill():
  while engineQueue.size < WINDOW and next sentence exists:
    engine.enqueue(next, utteranceId = sentence.id)

onUtteranceStart(id): cursor = indexOf(id); emit sentence; maybe save progress
onUtteranceDone(id):  engineQueue.remove(id); refill(); maybe emit needMore
                      if store exhausted and done: emit ended; stop
```

This loop is entirely native — no JS round-trip between sentences.

### 5.4 Android specifics

- **Foreground service** of type `mediaPlayback` (`FOREGROUND_SERVICE_MEDIA_PLAYBACK`
  permission already declared in `AndroidManifest.xml`); declare a new
  `<service android:name=".tts.TtsService" android:foregroundServiceType="mediaPlayback">`.
- **Engine:** `android.speech.tts.TextToSpeech`, `speak(text, QUEUE_ADD, params, utteranceId)`.
  `UtteranceProgressListener` → `onStart`, `onDone`, `onError`, and
  `onRangeStart` (API 26+) for optional word highlighting.
- **Media session:** `MediaSessionCompat` (or Media3 `MediaSession` with a
  thin custom `Player` adapter) + `MediaStyle` notification with
  play/pause/prev/next; handles BT/headset media buttons.
- **Audio focus:** `AudioManager.requestAudioFocus` with `AudioFocusRequest`
  (`USAGE_ASSISTANCE_ACCESSIBILITY` or `USAGE_MEDIA`); pause on loss, resume on gain;
  `ACTION_AUDIO_BECOMING_NOISY` receiver for headphone unplug.
- **Wake lock:** `PARTIAL_WAKE_LOCK` held while playing (defensive against
  aggressive OEM power management).
- **Engine init:** `TextToSpeech(context, onInit)` is async; buffer chunks
  until ready. Handle "no engine installed" / "language not supported" with
  a clear error and a deep link to system TTS settings.

### 5.5 iOS specifics

- **Engine:** `AVSpeechSynthesizer`; enqueue `AVSpeechUtterance`s (window of
  10–20), refill from `speechSynthesizer(_:didFinish:)`.
  `willSpeakRangeOfSpeechString` gives word ranges.
- **Audio session:** `AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)`
  and activate before speaking. `UIBackgroundModes: audio` is already in
  `Info.plist`. Set `synthesizer.usesApplicationAudioSession = true`.
- **Lock screen:** `MPRemoteCommandCenter` (play, pause, toggle, next/previous
  track → sentence/paragraph skip) and `MPNowPlayingInfoCenter` (title,
  author, chapter, cover artwork).
- **Interruptions:** observe `AVAudioSession.interruptionNotification` and
  `routeChangeNotification` (pause on headphone unplug).
- Voices: `AVSpeechSynthesisVoice.speechVoices()`, include quality
  (default / enhanced / premium).

### 5.6 Coexistence with the audiobook player

- Starting TTS pauses `AbsAudioPlayer` playback, and starting an audiobook
  stops TTS. Only one owns the media session / notification at a time.
- The TTS session must **not** create a `PlaybackSession` or report listening
  time — it only updates ebook progress.

---

## 6. Progress & sync

Today `EpubReader.vue#updateProgress` saves `{ ebookLocation, ebookProgress }`
via `$db.updateLocalEbookProgress` (local items) and
`PATCH /api/me/progress/:id` (server items).

With TTS:

- **Screen on:** the reader follows the spoken sentence, so `relocated` fires
  and the existing `updateProgress` path saves the CFI as normal.
- **Screen off:** native saves progress itself, throttled (e.g. every 30 s and
  on pause/stop):
  - local items → native local DB, same fields as `updateLocalEbookProgress`
  - server items → `PATCH /api/me/progress/:id` with `ebookLocation` (CFI of
    current sentence) via the native HTTP layer (`ApiHandler.kt` on Android,
    equivalent on iOS)
  - `ebookProgress`: approximate as `currentId / totalSentenceEstimate`, or
    send only `ebookLocation` and let the reader recompute when opened.
- **On resume:** JS reads `AbsTts.getState()` and displays `currentCfi`.

---

## 7. UI

### 7.1 Reader toolbar (`Reader.vue`)

- New headphones/"read aloud" button (EPUB only, next to the settings button).
- When active, a compact control bar at the bottom of the reader:
  `⏮ sentence back | ⏯ | sentence forward ⏭ | speed | voice | ⏻ stop`.

### 7.2 Settings

Stored with the existing ereader settings (`ereaderSettings` in `Reader.vue`):

```js
tts: {
  rate: 1.0,
  pitch: 1.0,
  voiceId: null,        // null = system default for book language
  followAlong: true,    // auto page-turn to the spoken sentence
  highlight: true,
  readAltText: false,
  readFootnotes: false
}
```

Per-book overrides (voice/language) keyed by `libraryItemId`.

### 7.3 Interactions

- Long-press / double-tap a paragraph → "Read from here" → `reset` + new stream from that CFI.
- Volume-button page navigation: respect existing
  `navigateWithVolumeWhilePlaying` setting so volume keys still change volume
  during TTS by default.

---

## 8. Skipping, seeking & resets

| Action | Handling |
|---|---|
| Sentence / paragraph skip | Native only — move cursor, flush engine queue, refill. |
| Rate / pitch / voice change | Native only — flush and refill from current sentence. |
| "Read from here" / chapter jump, target already received | `seekToSentence({ id })` (JS looks up the id by CFI from what it has sent). |
| Target not yet received | `reset({ streamId: n+1 })` → JS restarts the generator at that CFI with the new `streamId`; stale chunks ignored. |
| User manually turns pages while playing | No effect on playback; "follow along" temporarily suspended until the user taps "jump to current". |

---

## 9. Edge cases

- **One massive chapter:** handled by chunking (§4.2).
- **One massive paragraph / run-on sentence:** split by the long-sentence guard (§4.1).
- **Empty / image-only sections:** produce no sentences, no chunks.
- **Fixed-layout / pre-paginated EPUBs:** text extraction still works; auto page-turn uses CFI display.
- **RTL and CJK text:** `Intl.Segmenter` handles CJK sentence boundaries; voice must match language.
- **No voice for book language:** fall back to default voice with a warning; offer voice picker.
- **TTS engine killed by OS (Android):** restart engine, resume from current sentence.
- **App process killed while locked:** on next launch, offer "Resume listening" from the last saved CFI.
- **DRM / encrypted EPUBs:** out of scope (same as the reader).

---

## 10. Future: server-rendered TTS

The JS text pipeline (§4) and the plugin API (§5.1) are engine-agnostic. A
future `ServerTtsEngine` inside the native plugin could request audio for each
sentence/chunk from a server (Piper, Kokoro, or a cloud API), buffer it, and
play it with the same feeder loop, events and media session. Nothing in the
reader or UI needs to change.

---

## 11. Implementation plan

### Phase 1 — JS text pipeline
- [ ] `utils/tts/sentenceStream.js`: spine walker, block walker, filters, `Intl.Segmenter`, CFI per sentence, long-sentence guard.
- [ ] `utils/tts/chunkSender.js`: chunking, small first chunk, yielding, `streamId`/`seq`, `needMore` handling, `reset`.
- [ ] Unit-test extraction on sample EPUBs (huge chapter, footnotes, ruby, RTL, CJK).

### Phase 2 — Android `AbsTts`
- [ ] `AbsTts.kt` plugin + registration in `MainActivity.kt`.
- [ ] `TtsService` foreground service, `TextToSpeech` engine, feeder loop.
- [ ] Media session + notification + BT buttons, audio focus, noisy receiver, wake lock.
- [ ] Events: `sentence`, `state`, `needMore`, `ended`, `error`.
- [ ] Verify: 2+ hours screen-off on a stock Android device and one aggressive OEM (Samsung/Xiaomi).

### Phase 3 — Reader integration
- [ ] `plugins/capacitor/AbsTts.js` wrapper.
- [ ] Toolbar button + control bar in `Reader.vue`.
- [ ] Highlighting + follow-along in `EpubReader.vue`; resume sync via `getState()`.
- [ ] Settings (rate, voice, follow-along, highlight) in the ereader settings modal.
- [ ] Coexistence with `AbsAudioPlayer`.

### Phase 4 — iOS `AbsTts`
- [ ] `AbsTts.swift` + registration in `MyViewController.swift`.
- [ ] `AVSpeechSynthesizer` feeder loop, `.playback`/`.spokenAudio` session.
- [ ] `MPRemoteCommandCenter` / `MPNowPlayingInfoCenter`, interruptions, route changes.
- [ ] Word-level highlight events.
- [ ] Verify: long screen-off session; confirm whole-book eager streaming completes before lock.

### Phase 5 — Progress & polish
- [ ] Native throttled progress saving (local DB + server PATCH) while locked.
- [ ] Sleep timer (timed + end of chapter).
- [ ] "Read from here", paragraph/chapter skip.
- [ ] Voice picker + per-book overrides; pitch.
- [ ] Strings in `strings/` for all new UI.

### Phase 6 — Later
- [ ] Server-rendered TTS engine.
- [ ] Android Auto / CarPlay.
- [ ] Pronunciation dictionary.

---

## 12. Testing checklist

- [ ] Starts within ~1 s of tapping play.
- [ ] Plays continuously for 2+ hours with screen off (Android & iOS).
- [ ] Lock-screen and BT controls work; headphone unplug pauses.
- [ ] Phone call / navigation prompt pauses and resumes correctly.
- [ ] Book with a single 1 MB+ chapter streams without UI jank.
- [ ] Highlight and page follow-along are correct after resuming from lock.
- [ ] Progress saved while locked appears on another device / web client.
- [ ] Switching between TTS and audiobook playback hands over cleanly.
- [ ] Rate/voice change applies immediately without losing position.
- [ ] Footnotes, ruby, page markers not read (unless enabled).
