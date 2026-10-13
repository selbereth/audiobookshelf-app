# Audiobookshelf for Pebble

A small watchapp that controls the Audiobookshelf Android app: start the book played most recently, play and
pause it, skip ahead and back.

| Button | Does |
|---|---|
| Select | Play or pause. With nothing loaded it starts the book played most recently, from where it was left. |
| Up | Skip back (the jump back time from the app's settings) |
| Down | Skip ahead (the jump forward time from the app's settings) |
| Hold Up | Volume up, one step every 0.4 s while held (the phone's media volume); the skip-back arrow shows a + while held |
| Hold Down | Volume down, the same way (the arrow shows a - while held) |

The watch sends commands and shows what the phone says is playing. The phone side is
`android/app/src/main/java/com/audiobookshelf/app/pebble/`. It uses [PebbleKit Android 2](https://github.com/pebble-dev/PebbleKitAndroid2):
the Pebble app (Core Devices or Rebble) binds to `PebbleListenerService` when the watchapp is opened, which starts the
Audiobookshelf app's process if it is not running. The watchapp has no JavaScript part (`src/pkjs`): with one, the
messages would go to it instead of to the Android app.

## What the phone needs

- The Core Devices (or Rebble) Pebble app, connected to the watch. When the watchapp asks for the first time, allow it
  to talk to Audiobookshelf in the Pebble app's *Watch App Permissions*.
- **Battery usage set to Unrestricted for Audiobookshelf** (Android settings, Apps, Audiobookshelf, Battery) if you want to start
  a book from the watch while the app is closed. Android 12 and later refuse to start a media service from the
  background otherwise, and the watch then shows "Open Audiobookshelf on the phone". Play, pause and skip work without
  it as long as the app's player is already running.
- Android 16 also ignores the audio focus request of an app in the background, so a book started from the watch can
  load but stay silent. The phone side notices this and asks the player to play again a few seconds later.

## Build

You need the [Pebble SDK](https://developer.repebble.com/sdk/) (`pebble` command).

```sh
cd pebble
pebble build                                  # builds build/pebble.pbw for emery (Time 2), basalt, diorite and flint
pebble install --phone <phone-ip>             # install on the watch through the Pebble app's developer connection
```

Try the watchapp in the emulator (needs `qemu-pebble`, see the repository's `AGENTS.md`): `pebble install --emulator emery`, then act as the phone with
`pebble send-app-message --emulator emery --uint 1=2 --string 2="A title"` (State 0 nothing, 1 paused, 2 playing, 3 starting, 4 error).

Try the phone side without a watch (debug builds only, from adb): `adb shell am broadcast -n com.selbereth.audiobookshelf.debug/com.audiobookshelf.app.pebble.PebbleDebugReceiver --ei command 1`
where command is 0 status, 1 play or pause (starts the most recent book), 2 skip ahead, 3 skip back, 4 volume up, 5 volume down. The answer is in
logcat under `PebbleDebug`.

## Keep in sync

These must match between the watch and the phone:

- the watchapp UUID: `pebble.uuid` in `package.json` and `WATCHAPP_UUID` in `PebbleProtocol.kt`
- the message keys: `pebble.messageKeys` in `package.json` and `KEY_*` in `PebbleProtocol.kt`
- the command and state numbers: the `#define`s in `src/c/main.c` and `CMD_*` / `STATE_*` in `PebbleProtocol.kt`
- the Android app ids: `pebble.companionApp.android.apps` in `package.json` (release and debug builds). The Pebble app uses the **first**
  listed app that is installed, so with both on one phone the debug build must come first, or the store build (which has no
  receiver yet) gets the messages.
