import Vue from 'vue'
import { AbsAudioPlayer } from './AbsAudioPlayer'
import { AbsDownloader } from './AbsDownloader'
import { AbsFileSystem } from './AbsFileSystem'
import { AbsDatabase } from './AbsDatabase'
import { AbsLogger } from './AbsLogger'
import { AbsDebugLog } from './AbsDebugLog'
import { AbsTts } from './AbsTts'
import { AbsCore, callCore, onCore } from './AbsCore'
import { Capacitor } from '@capacitor/core'

Vue.prototype.$platform = Capacitor.getPlatform()

export { AbsAudioPlayer, AbsDownloader, AbsFileSystem, AbsLogger, AbsDebugLog, AbsDatabase, AbsTts, AbsCore, callCore, onCore }
