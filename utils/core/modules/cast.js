/**
 * The Cast decisions that are not the SDK's (Phase 10, slice C1): which player is used when a Cast session starts or ends, and
 * the device volume the Cast receiver is set to. Ported from android/app/src/main/java/com/audiobookshelf/app/player/PlayerNotificationService.kt
 * (switchToPlayer 712-730, setMediaSessionToCastVolume 774-789). Every rule names its Kotlin source (file:line).
 *
 * Not moved: the Cast session itself, the route scan, the chooser, the receiver's status and its load and seek calls (the SDK's),
 * the media session wiring and the preparation of the new player (native, for now).
 *
 * It runs only while the switch `system.flags` {coreCast} is on (start() reads it, default off). While it is off the Kotlin
 * code decides, as before. Native asks with CoreCast.kt, only while CoreHost is ready, and falls back to its own rule when the
 * core does not answer.
 *
 * Calls in (native asks, the core answers):
 *   cast.switchPlan {useCast, current: 'cast'|'exo', hasCastPlayer, wasPlaying}
 *       -> {ok, noop, stop: 'exo'|'cast'|null, notifyPaused}
 *   cast.volumeSet {volume}                 -> {ok, volume}
 *   cast.volumeAdjust {current, direction}  -> {ok, volume}
 *
 * Differences kept on purpose, listed in the vault questions note: the answer comes back over the bridge, so the switch is applied
 * a moment after the request (the Kotlin switch ran at once on the main thread).
 */

export const MIN_VOLUME = 0 // PlayerNotificationService.kt:779, :787 coerceIn(0, 100)
export const MAX_VOLUME = 100

const clampVolume = (v) => Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.trunc(Number(v) || 0)))

/**
 * PlayerNotificationService.kt:712-730 switchToPlayer, the part that decides. A request for the player already in use does
 * nothing (`noop`, Kotlin returns before any change). Otherwise the other player is stopped, when there is one.
 */
export function switchPlan({ useCast, current, hasCastPlayer, wasPlaying }) {
  if (useCast) {
    if (current === 'cast') return { noop: true, stop: null, notifyPaused: false } // :715-717 "Already using Cast Player"
    return { noop: false, stop: 'exo', notifyPaused: !!wasPlaying } // :720 mPlayer.stop(); :765-766 pause event when it was playing
  }
  if (current === 'exo') return { noop: true, stop: null, notifyPaused: false } // :723-725 "Already using Exo Player"
  return { noop: false, stop: hasCastPlayer ? 'cast' : null, notifyPaused: !!wasPlaying } // :726-729 castPlayer?.stop() when there is one
}

/** PlayerNotificationService.kt:779 onSetVolumeTo: clamp, the value is what is set */
export function volumeSet(volume) {
  return clampVolume(volume)
}

/** PlayerNotificationService.kt:786-787 onAdjustVolume: the current value plus the step, clamped */
export function volumeAdjust(current, direction) {
  return clampVolume((Number(current) || 0) + (Number(direction) || 0))
}

export function castModule(bridge, { log = () => {} } = {}) {
  let gate = Promise.resolve(false) // the switch, read once by start()

  const OFF = { ok: false, off: true }
  const serve = (fn) => async (args) => {
    const on = await gate
    if (!on) return OFF
    return { ok: true, ...fn(args || {}) }
  }

  function start() {
    gate = bridge.call('system', 'flags', {}).then(
      (f) => f?.coreCast === true,
      (e) => {
        log('cast: the switch could not be read, the core Cast rules stay off: ' + (e && e.message))
        return false
      }
    )
    bridge.serve('cast', 'switchPlan', serve((a) => switchPlan(a)))
    bridge.serve('cast', 'volumeSet', serve((a) => ({ volume: volumeSet(a.volume) })))
    bridge.serve('cast', 'volumeAdjust', serve((a) => ({ volume: volumeAdjust(a.current, a.direction) })))
  }

  return { start }
}
