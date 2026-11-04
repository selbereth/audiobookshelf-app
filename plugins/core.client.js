import { Capacitor } from '@capacitor/core'
import { callCore, onCore } from './capacitor/AbsCore'

/**
 * The UI is a client of the JS core (Android only for now, iOS keeps its native logic). It listens to the core's events and,
 * later phases, sends it commands. For now it only says hello so the link can be seen in the web console.
 */
export default async function ({ store }) {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    await onCore((event, data) => {
      console.log('[core] event ' + event + ' ' + JSON.stringify(data))
    })
    const answer = await callCore('hello')
    console.log('[core] hello answered ' + JSON.stringify(answer))
  } catch (e) {
    console.error('[core] not reachable: ' + e)
  }
}
