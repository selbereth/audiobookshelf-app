import { Capacitor } from '@capacitor/core'
import { callCore, onCore } from './capacitor/AbsCore'

/**
 * The UI is a client of the JS core (Android only for now, iOS keeps its native logic). It listens to the core's events and, when the
 * switch coreUi is on (Phase 6, read by the core at start), keeps the store's device data in step with what the core saved
 * (`deviceChanged`). With the switch off the UI only logs the events, and its own copy is the only one, as before.
 */
export default async function ({ store }) {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    let mirror = false
    await onCore((event, data) => {
      console.log('[core] event ' + event + ' ' + JSON.stringify(data))
      if (event === 'deviceChanged' && mirror && data?.deviceData) {
        store.commit('setDeviceData', data.deviceData)
        console.log('[core] mirror: device data set from core, lastServerConnectionConfigId ' + data.deviceData.lastServerConnectionConfigId)
      }
    })
    const answer = await callCore('hello')
    console.log('[core] hello answered ' + JSON.stringify(answer))
    // Remove progress, local files and logs with nothing behind them (the native plugin did this when the screen opened)
    const cleaned = await callCore('db.cleanup', {}, 60000)
    console.log('[core] db cleanup ' + JSON.stringify(cleaned))
    // Phase 6: the switch. When it is on, take the core's copy once (events sent before this point are not replayed to the store)
    const { coreUi } = (await callCore('db.mirrorSwitch')) || {}
    console.log('[core] ui mirror ' + (coreUi ? 'on' : 'off'))
    if (coreUi) {
      mirror = true
      store.commit('setDeviceData', await callCore('db.getDeviceData'))
      console.log('[core] mirror: device data read from core at start')
    }
  } catch (e) {
    console.error('[core] not reachable: ' + e)
  }
}
