# Agent instructions: audiobookshelf-app

A fork of the Audiobookshelf mobile app (Nuxt 2 / Vue 2 inside Capacitor, with native Android Kotlin and iOS Swift plugins).
The general rules for all projects, including the Obsidian vault notes and the end-of-session handoff, are in
`/Users/samuelthompson/projects/AGENTS.md`. Read them as well. This file is only about this repository.

## Branches

Work is split into branches that must merge cleanly with each other. Do not mix them.

| Branch | Holds | Vault note |
|---|---|---|
| `master` | the base | |
| `tts` | EPUB read-aloud (text to speech), shared player, sticky pages, recents-jump fix, deep link `audiobookshelf://item/<id>` | `audiobookshelf-epub-tts` |
| `add-auto-delete` | auto-delete of finished downloads | `audiobookshelf-auto-delete` |
| `pebble` | the phone side of the Pebble watch app (the watchapp is in its own repo, `selbershelf-pebble`) | `audiobookshelf-pebble` |

- Check `git branch --show-current` before you start. Features that exist on another branch are not on this one.
- Prefer new files. When a shared file must change (`android/app/build.gradle`, `AndroidManifest.xml`, `MainActivity.kt`,
  `AudioPlayer.vue`), keep the edit small and put it at the end of its block. Check with
  `git diff > p.patch` then `git apply --check --3way p.patch` in a `git worktree` of the other branches.
- Never commit or push unless asked. Never run `ssh`.

## Build and run

Everything below runs from the shell. Android Studio is not needed.

```sh
# 1. Web part: builds the Nuxt app and copies it into android/ and ios/ (about 3 s when nothing changed)
npm run sync

# 2. Android debug APK (package com.selbereth.audiobookshelf.debug, activity com.audiobookshelf.app.MainActivity)
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk

# 3. Install and start
A=$ANDROID_HOME/platform-tools/adb
$A devices -l                        # emulator-5554 and the Pixel (USB serial, or a Wi-Fi debugging name)
$A -s <device> install -r app/build/outputs/apk/debug/app-debug.apk
$A -s <device> shell am start -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.MainActivity
```

- Capacitor needs **JDK 21**. The system default is JDK 25 (Gradle 8.11 cannot run on it) and `~/.gradle/jdks` only has 17
  (fails with "invalid source release: 21"). Use the Homebrew `openjdk@21` above.
- A web change needs step 1 and then step 2 (the APK carries the web files). A Kotlin-only change needs step 2 only.
- iOS: `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -destination 'id=<simulator id>' -derivedDataPath <tmp dir> build`.
  The simulator only gets as far as the login screen unless you give it credentials.
- Logs: `adb -s <device> logcat -d | grep -a "Capacitor/Console"` shows the web console; `grep -a "PebbleDebug"` etc. for native tags.

## Devices and testing

- **Emulator** (`emulator-5554`, Android 16): has the user's server and books already signed in. Its Google text-to-speech engine
  crashes (SIGILL), so debug builds on an emulator use a fake speech engine (`TtsController.useFakeEngine`, tts branch). Real speech
  needs the Pixel.
- **Pixel 7a**: prefer USB (serial from `adb devices`). Wi-Fi debugging works too but the port changes each time and the device name
  has the form `adb-<serial>-xxxx._adb-tls-connect._tcp`. It relocks behind a fingerprint: ask the user to unlock it, and never try to
  unlock it. It has a 3-button navigation bar, so layouts differ from the emulator. A quick double press of the square button
  switches to the previous app instead of showing recents.
- Drive the UI with `adb shell input tap/swipe/text/keyevent` and look at `adb exec-out screencap -p` images. Screens move
  (banners, status bar), so look at a screenshot before tapping, and prefer a deep link or an `adb` command to get to a screen.
- The server library is real data. Do not delete or edit books. Do not download large things (JDKs, models, SDKs) without asking:
  the user is sometimes on a phone hotspot.
- Put screenshots and temporary files in a temp dir (`mktemp -d`), not in the repo. The agent scratchpad is cleaned up by macOS
  after a few days, so do not keep tools (such as a JDK) there. macOS also blocks reading `~/Downloads`.
- When you change behaviour, test it on the emulator first and then say honestly what was and was not checked on the Pixel.

## How the app is laid out

- Web: `pages/`, `components/` (the player is `components/app/AudioPlayer.vue`, rendered by `AudioPlayerContainer.vue`; readers are
  `components/readers/`), `store/` (Vuex), `plugins/capacitor/` (JS wrappers of the native plugins), `strings/en-us.json` (add every
  new user-facing string here).
- Android native: `android/app/src/main/java/com/audiobookshelf/app/`. The audiobook player is `player/PlayerNotificationService.kt`
  (a foreground service holding ExoPlayer and the MediaSession). Capacitor plugins are in `plugins/`. `device/DeviceManager.kt` holds
  device data, including `lastPlaybackSession` (the most recently played book). The home-screen widget is `MediaPlayerWidget.kt`.
- iOS native: `ios/App/App/` (Swift plugins in `plugins/`).
- Android 12+ refuses to start a foreground service from the background (`ForegroundServiceStartNotAllowedException`) unless the app's
  battery usage is Unrestricted, and Android 16 ignores audio focus requests from a background app. Keep both in mind for anything
  that starts playback without the app's screen open.

## Pebble watch app (phone side)

The watchapp itself is a **separate repo**, `/Users/samuelthompson/projects/selbershelf-pebble` (its own `AGENTS.md` has the build,
emulator and Core-app pairing recipes). This repo holds only the phone side, `android/app/src/main/java/com/audiobookshelf/app/pebble/`
(`PebbleListenerService`, `PebbleController`, `PebbleProtocol`) and a debug-only `PebbleDebugReceiver` in `android/app/src/debug/`.
Change both repos together for anything that crosses the line: the UUID, message keys, command and state numbers, and the app ids
(see the sync list in the watchapp repo).

- It uses PebbleKit Android 2: the Core Devices Pebble app binds to `PebbleListenerService` (declared with the action
  `io.rebble.pebblekit2.RECEIVE_DATA_FROM_WATCH`) when the watchapp opens, which starts this app's process when it is closed. The
  watchapp has no `src/pkjs`: with one, the messages would go to the JavaScript instead of the Android app.
- Library `io.rebble.pebblekit2:client` is pinned to **1.2.0**: 1.3.0 and later need compileSdk 37. It is built with a newer Kotlin than
  this project's 2.0/2.1, so `app/build.gradle` has `-Xskip-metadata-version-check`. Do not upgrade the project's Kotlin or Android
  Gradle plugin for this: it would conflict with the other branches.
- The Core app delivers numbers from the watch as `UInt32`, whatever the watch wrote. The listener accepts any integer type: an earlier
  strict `UByte` check silently refused every command.
- The app's screen sets `DeviceManager.serverConnectionConfig`; started from the watch there is no screen, so `PebbleController` loads the
  saved one before asking the server to play a book that is not downloaded.
- Try the phone side without a watch (debug builds): `adb shell am broadcast -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.pebble.PebbleDebugReceiver --ei command <0..5>`
  (0 status, 1 play or pause and start the most recent book, 2 skip ahead, 3 skip back, 4 volume up, 5 volume down) and read logcat tag `PebbleDebug`.
  Starting from a stopped app only works after
  `adb shell dumpsys deviceidle whitelist +com.selbereth.audiobookshelf.debug` (the same as setting battery usage to Unrestricted).
- A sibling project, `~/projects/find-pebble`, is a find-my-phone Pebble app. It uses the classic PebbleKit broadcast and is a useful
  reference for the Core Devices app's behaviour (vault note `find-pebble`).

## Working style for this repo

- Say what you verified and how (the command or the screenshot) and what you did not run. Do not claim a Pixel result from an
  emulator run.
- Fix the cause, not the symptom: reproduce the bug first (logs, a measurement, a screenshot), then change the code, then re-run
  the same check.
- Remove temporary logging (`TMP`, `TMPDEBUG`) before finishing.
- Keep the vault note of the topic current as you work (the `## Now` block), as the vault rules require.
