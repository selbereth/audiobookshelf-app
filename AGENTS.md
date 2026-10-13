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
| `pebble` | Pebble watch app that controls the audiobook player | `audiobookshelf-pebble` |

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

## Pebble watch app and emulator (`pebble/`, `pebble` branch)

The watch app is in `pebble/` (C, targets emery, basalt, diorite, flint). Run it in the emulator on macOS arm64. Verified
2026-10-12 with basalt.

One-time setup (ask the user first: it downloads a few hundred MB):
```sh
brew install node libpng uv
uv tool install pebble-tool --python 3.13   # 3.10-3.13 only; 3.14 unsupported; 3.11 fails with "SRE module mismatch"
pebble sdk install latest                   # 4.33.1 at the time of writing
curl -LsSf https://github.com/coredevices/PebbleOS-SDK/releases/latest/download/pebbleos-sdk-installer.sh -o installer.sh
sh installer.sh --defaults                  # read installer.sh first; installs ~/pebbleos-sdk-<version>
```
The PebbleOS SDK supplies `qemu-pebble` (the emulator) and the ARM compiler; `pebble sdk install` alone does not. Do not use the
Homebrew `pebble/pebble-sdk` tap: its `pebble-qemu` formula is from 2016 and Intel-only.

Every shell:
```sh
export PATH="$HOME/.local/bin:$PATH"          # the pebble command
. ~/pebbleos-sdk-<version>/env.sh             # qemu-pebble and arm-none-eabi-gcc
cd pebble && pebble build                     # writes build/pebble.pbw
pebble install --emulator basalt              # also emery, diorite, flint
pebble screenshot --no-open --emulator basalt "$TMPDIR/shot.png"   # then Read the PNG
pebble emu-button click select --emulator basalt
pebble logs --emulator basalt
pebble kill && pebble wipe                    # emulator stuck, stale app, or "TimeoutError" on install
```

- Emulator keys: Q back, W up, S select, X down. Add `--vnc` when there is no display.
- The emulator has no phone, so the app shows "No answer. Is the Pebble app connected and Audiobookshelf installed?". That is
  the app working without the Android companion, not a crash. Playback control needs a real watch paired to the Pixel or
  emulator-5554 running the `pebble` branch build.
- Run on 2026-10-12: emery, diorite and basalt (screens, icons, all five states, button commands, the no-answer timeout). Flint has not
  been run. The JS companion (`pkjs`) is not used by this app.
- To act as the phone without the Android side: `pebble send-app-message --emulator emery --uint 1=<state 0-4> --string 2="<title>"`
  (the tool wants the numeric keys, State is 1 and Title is 2). `pebble emu-button click <up|select|down>` works only in this mode:
  it restarts `pypkjs`, which takes the one Pebble connection, so it cannot be used while the Core app is paired.
- If `qemu-pebble` is "not found" in a shell that did not source `env.sh`: `export PEBBLE_QEMU_PATH=$HOME/pebbleos-sdk-0.1.11/qemu/bin/qemu-pebble`.

### Pairing the Pebble emulator with the Android emulator (verified 2026-10-12)

This runs the whole chain: watch app (Pebble emulator) -> Core Devices app (Android emulator) -> `PebbleListenerService` in the
debug app. The Core Devices app is not on F-Droid, and the Play Store on the emulator needs a Google sign-in, so build it from
source: `git clone https://github.com/coredevices/mobileapp` (a full clone, so the `git describe` version works), copy
`androidApp/src/google-services-dummy.json` to `google-services.json`, put `sdk.dir=...` in `local.properties`, then
`JAVA_HOME=<openjdk@21> ./gradlew :androidApp:assembleDebug` (about 10 minutes, downloads Android platform 37) and
`adb -s emulator-5554 install -r androidApp/build/outputs/apk/debug/androidApp-debug.apk`. Run `./gradlew --stop` afterwards: the
daemons make the emulator report "System UI isn't responding".
```sh
E=emulator-5554; A=$ANDROID_HOME/platform-tools/adb
pebble install --emulator basalt                 # starts qemu-pebble and pypkjs; note the first tcp:: port of qemu-pebble
pkill -f pypkjs                                  # the Pebble protocol port takes ONE client; pypkjs holds it otherwise
$A -s $E reverse tcp:<port> tcp:<port>
$A -s $E shell am broadcast -a coredevices.coreapp.SET_SETTING -n coredevices.coreapp/coredevices.coreapp.debug.SetSettingReceiver --es key hasSeenWatchOnboarding --ez value true
$A -s $E shell am broadcast -a coredevices.coreapp.ADD_QEMU_WATCH -n coredevices.coreapp/coredevices.coreapp.debug.QemuSetupReceiver --es host 127.0.0.1 --ei port <port>
export PATH="$ANDROID_HOME/platform-tools:$PATH"; pebble install --adb      # installs through the Core app; also pebble screenshot --adb --no-open <png>
```
- `<port>` is the first `-serial tcp::NNNNN` of `qemu-pebble` (`ps -o args= -p $(pgrep qemu-pebble)`); the second is the console.
- Verified: install through the Core app, screenshot shows "Paused / Solo Leveling, Vol. 7", log tag `PebbleListenerService` shows
  `Sent status 1`. Not verified: a button press (`pebble emu-button` has no `--adb`; press S in the emulator window) and playback
  start from the watch.

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

## Pebble watch app (branch `pebble`)

- `pebble/` is the watchapp (C, Pebble SDK). The phone side is `android/.../pebble/` (`PebbleListenerService`, `PebbleController`,
  `PebbleProtocol`) and a debug-only `PebbleDebugReceiver` in `android/app/src/debug/`. `pebble/README.md` has the user-facing
  description and the list of things that must stay in sync: UUID, message keys, command and state numbers, Android app ids.
- It uses PebbleKit Android 2: the Core Devices Pebble app binds to `PebbleListenerService` (declared with the action
  `io.rebble.pebblekit2.RECEIVE_DATA_FROM_WATCH`) when the watchapp opens, which starts this app's process when it is closed. The
  watchapp has no `src/pkjs`: with one, the messages would go to the JavaScript instead of the Android app.
- Library `io.rebble.pebblekit2:client` is pinned to **1.2.0**: 1.3.0 and later need compileSdk 37. It is built with a newer Kotlin than
  this project's 2.0/2.1, so `app/build.gradle` has `-Xskip-metadata-version-check`. Do not upgrade the project's Kotlin or Android
  Gradle plugin for this: it would conflict with the other branches.
- Build the watchapp (does not need a download): put these on PATH, then `pebble build` in `pebble/`:
  `~/projects/calendar-pebble-watchface/.pebble-venv/bin` and `~/projects/calendar-pebble-watchface/.arm-gnu-toolchain/bin`
  (`~/.local/bin/pebble` also exists). It builds `emery` (Pebble Time 2), `basalt`, `diorite` and `flint`.
- Verified end to end on 2026-10-12 with the Pebble emulator paired to the Android emulator through the Core app (see the pairing
  recipe above): opening the watchapp starts the app's process and the phone's status appears on the watch; the commands play (from a
  stopped app), skip ahead, skip back and pause reached the player and the watch showed the answers. Not run on a real watch.
- The Core app delivers numbers from the watch as `UInt32`, whatever the watch wrote (`dict_write_uint8` arrives as `UInt32`). The
  listener accepts any integer type: an earlier strict `UByte` check silently refused every command.
- Pressing a button while the Core app is paired needs a person at the emulator window (keys Q W S X): the CLI cannot, and macOS does
  not let the agent send keystrokes (Apple events are not authorized). A temporary test build that sends its own command sequence
  from a timer worked (remove it afterwards).
- The watch's action bar icons are white shapes on transparent: black ones are invisible on the bar.
- Try the phone side without a watch (debug builds): `adb shell am broadcast -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.pebble.PebbleDebugReceiver --ei command <0|1|2|3>`
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
