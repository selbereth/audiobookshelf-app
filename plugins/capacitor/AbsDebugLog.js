import { registerPlugin } from '@capacitor/core'

// Android only: the settings page shows the debug logs section only on Android (see pages/settings.vue)
const AbsDebugLog = registerPlugin('AbsDebugLog')

export { AbsDebugLog }
