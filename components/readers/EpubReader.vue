<template>
  <div id="epub-frame" class="w-full">
    <div id="viewer" class="h-full w-full"></div>

    <!-- TTS controls -->
    <div v-if="ttsActive" class="fixed left-0 w-full h-12 px-4 flex items-center justify-center space-x-4 z-20" :class="isLightTheme ? 'bg-gray-100 text-black' : isDarkTheme ? 'bg-[#2e2e2e] text-white' : 'bg-[#111] text-white'" :style="{ bottom: isPlayerOpen ? '152px' : '32px' }" @touchstart.stop @touchend.stop>
      <button type="button" class="flex" @click.stop="ttsSkip(-1)"><span class="material-symbols text-2xl">skip_previous</span></button>
      <button type="button" class="flex" @click.stop="ttsTogglePlay"><span class="material-symbols text-3xl">{{ ttsPlaying ? 'pause' : 'play_arrow' }}</span></button>
      <button type="button" class="flex" @click.stop="ttsSkip(1)"><span class="material-symbols text-2xl">skip_next</span></button>
      <button type="button" class="text-sm w-12" @click.stop="ttsCycleRate">{{ ttsRate }}x</button>
      <button type="button" class="flex" @click.stop="stopTts"><span class="material-symbols text-2xl">close</span></button>
    </div>

    <div class="fixed left-0 h-8 w-full px-4 flex items-center" :class="isLightTheme ? 'bg-white text-black' : isDarkTheme ? 'bg-[#232323] text-white/80' : 'bg-black text-white/80'" :style="{ bottom: isPlayerOpen ? '120px' : '0px' }">
      <p v-if="totalLocations" class="text-xs text-slate-600">Location {{ currentLocationNum }} of {{ totalLocations }}</p>
      <div class="flex-grow" />
      <p class="text-xs">{{ progress }}%</p>
    </div>
  </div>
</template>

<script>
import ePub from 'epubjs'
import { AbsTts, AbsAudioPlayer } from '@/plugins/capacitor'
import { sentenceStream } from '@/utils/tts/sentenceStream'
import { ChunkSender } from '@/utils/tts/chunkSender'

export default {
  props: {
    url: String,
    libraryItem: {
      type: Object,
      default: () => {}
    },
    isLocal: Boolean,
    keepProgress: Boolean
  },
  data() {
    return {
      /** @type {ePub.Book} */
      book: null,
      /** @type {ePub.Rendition} */
      rendition: null,
      progress: 0,
      totalLocations: 0,
      currentLocationNum: 0,
      currentLocationCfi: null,
      inittingDisplay: true,
      isRefreshingUI: false,
      ttsActive: false,
      ttsPlaying: false,
      ttsRate: 1,
      ttsStreamId: 0,
      ttsHighlightCfi: null,
      ttsListeners: [],
      ttsSender: null,
      ttsSentenceCfis: {},
      ereaderSettings: {
        theme: 'dark',
        font: 'serif',
        fontScale: 100,
        lineSpacing: 115,
        textStroke: 0
      }
    }
  },
  watch: {
    isPlayerOpen() {
      this.refreshUI()
    }
  },
  computed: {
    /** @returns {string} */
    libraryItemId() {
      return this.libraryItem?.id
    },
    localLibraryItem() {
      if (this.isLocal) return this.libraryItem
      return this.libraryItem.localLibraryItem || null
    },
    localLibraryItemId() {
      return this.localLibraryItem?.id
    },
    serverLibraryItemId() {
      if (!this.isLocal) return this.libraryItem.id
      // Check if local library item is connected to the current server
      if (!this.libraryItem.serverAddress || !this.libraryItem.libraryItemId) return null
      if (this.$store.getters['user/getServerAddress'] === this.libraryItem.serverAddress) {
        return this.libraryItem.libraryItemId
      }
      return null
    },
    isPlayerOpen() {
      return this.$store.getters['getIsPlayerOpen']
    },
    readerHeightOffset() {
      return this.isPlayerOpen ? 204 : 104
    },
    /** @returns {Array<ePub.NavItem>} */
    chapters() {
      return this.book?.navigation?.toc || []
    },
    userItemProgress() {
      if (this.isLocal) return this.localItemProgress
      return this.serverItemProgress
    },
    localItemProgress() {
      return this.$store.getters['globals/getLocalMediaProgressById'](this.localLibraryItemId)
    },
    serverItemProgress() {
      return this.$store.getters['user/getUserMediaProgress'](this.serverLibraryItemId)
    },
    localStorageLocationsKey() {
      return `ebookLocations-${this.libraryItemId}`
    },
    savedEbookLocation() {
      if (!this.keepProgress) return null
      if (!this.userItemProgress?.ebookLocation) return null
      // Validate ebookLocation is an epubcfi
      if (!String(this.userItemProgress.ebookLocation).startsWith('epubcfi')) return null
      return this.userItemProgress.ebookLocation
    },
    isLightTheme() {
      return this.ereaderSettings.theme === 'light'
    },
    isDarkTheme() {
      return this.ereaderSettings.theme === 'dark'
    },
    themeRules() {
      const isDark = this.ereaderSettings.theme === 'dark'
      const isBlack = this.ereaderSettings.theme === 'black'
      const fontColor = isDark ? '#fff' : isBlack ? '#fff' : '#000'
      const backgroundColor = isDark ? 'rgb(35 35 35)' : isBlack ? 'rgb(0 0 0)' : 'rgb(255, 255, 255)'

      return {
        '*': {
          color: `${fontColor}!important`,
          'background-color': `${backgroundColor}!important`,
          'line-height': this.ereaderSettings.lineSpacing + '%!important',
          '-webkit-text-stroke': this.ereaderSettings.textStroke / 100 + 'px ' + fontColor + '!important'
        },
        a: {
          color: `${fontColor}!important`
        }
      }
    }
  },
  methods: {
    /** ---- Text to speech ---- */
    async toggleTts() {
      if (this.ttsActive) return this.stopTts()
      return this.startTts()
    },
    ttsCreateSender(startCfi) {
      this.ttsSender?.cancel()
      this.ttsStreamId++
      const streamId = this.ttsStreamId
      const startSpine = this.book.spine.get(startCfi)?.index || 0
      const signal = { cancelled: false }
      const stream = sentenceStream(this.book, { startSpine, startCfi, signal })
      const sender = new ChunkSender({
        stream,
        streamId,
        send: (chunk) => AbsTts.appendChunk(chunk)
      })
      const cancel = sender.cancel.bind(sender)
      sender.cancel = () => {
        signal.cancelled = true
        cancel()
      }
      this.ttsSender = sender
      return sender
    },
    async startTts() {
      if (!this.book || !this.rendition) return
      // Only one audio source at a time
      try {
        await AbsAudioPlayer.pausePlayer?.()
      } catch (error) {
        console.warn('[EpubReader] failed to pause audio player', error)
      }

      const startCfi = this.rendition.currentLocation()?.start?.cfi || this.currentLocationCfi
      const metadata = this.book.packaging?.metadata || {}
      this.ttsActive = true

      this.ttsListeners = [
        await AbsTts.addListener('sentence', (data) => this.onTtsSentence(data)),
        await AbsTts.addListener('state', (data) => {
          this.ttsPlaying = !!data.playing
        }),
        await AbsTts.addListener('needMore', () => {
          if (this.ttsSender && !this.ttsSender.running && !this.ttsSender.done) this.ttsSender.run()
        }),
        await AbsTts.addListener('ended', () => this.stopTts()),
        await AbsTts.addListener('error', (data) => {
          console.error('[EpubReader] TTS error', data)
          this.$toast.error(data.message || 'Text to speech error')
        })
      ]

      const sender = this.ttsCreateSender(startCfi)
      await AbsTts.start({
        libraryItemId: this.libraryItemId,
        localLibraryItemId: this.localLibraryItemId,
        title: this.libraryItem?.media?.metadata?.title || metadata.title || '',
        author: this.libraryItem?.media?.metadata?.authorName || metadata.creator || '',
        lang: metadata.language,
        rate: this.ttsRate,
        pitch: 1,
        streamId: this.ttsStreamId
      })
      sender.run()
      await AbsTts.play()
    },
    async stopTts() {
      this.ttsSender?.cancel()
      this.ttsSender = null
      this.ttsListeners.forEach((l) => l.remove())
      this.ttsListeners = []
      this.clearTtsHighlight()
      this.ttsActive = false
      this.ttsPlaying = false
      await AbsTts.stop()
    },
    async ttsTogglePlay() {
      if (this.ttsPlaying) await AbsTts.pause()
      else await AbsTts.play()
    },
    ttsSkip(count) {
      AbsTts.skip({ by: 'sentence', count })
    },
    ttsCycleRate() {
      const rates = [0.75, 1, 1.25, 1.5, 2, 2.5, 3]
      const idx = rates.indexOf(this.ttsRate)
      this.ttsRate = rates[(idx + 1) % rates.length]
      AbsTts.setRate({ rate: this.ttsRate })
    },
    clearTtsHighlight() {
      if (this.ttsHighlightCfi) {
        try {
          this.rendition.annotations.remove(this.ttsHighlightCfi, 'highlight')
        } catch (error) {
          console.warn('[EpubReader] failed to remove highlight', error)
        }
        this.ttsHighlightCfi = null
      }
    },
    onTtsSentence({ cfi }) {
      if (!this.rendition || !cfi) return
      this.clearTtsHighlight()
      try {
        this.rendition.annotations.highlight(cfi, {}, null, 'tts-highlight', { fill: 'yellow', 'fill-opacity': '0.35', 'mix-blend-mode': 'normal' })
        this.ttsHighlightCfi = cfi
      } catch (error) {
        console.warn('[EpubReader] failed to highlight', error)
      }
      // Follow along: turn the page when the sentence is outside the visible range
      const loc = this.rendition.currentLocation()
      if (loc?.start && loc?.end) {
        const compare = new ePub.CFI()
        const before = compare.compare(cfi, loc.start.cfi) < 0
        const after = compare.compare(cfi, loc.end.cfi) > 0
        if (before || after) this.rendition.display(cfi)
      }
    },
    async syncTtsOnResume() {
      if (!this.ttsActive) return
      const state = await AbsTts.getState()
      if (!state.active) {
        this.ttsActive = false
        this.ttsPlaying = false
        return
      }
      this.ttsPlaying = state.playing
      if (state.currentCfi) this.onTtsSentence({ cfi: state.currentCfi })
    },
    updateSettings(settings) {
      this.ereaderSettings = settings

      if (!this.rendition) return

      this.applyTheme()

      const fontScale = settings.fontScale || 100
      this.rendition.themes.fontSize(`${fontScale}%`)
      this.rendition.themes.font(settings.font)
      this.rendition.spread(settings.spread || 'auto')
    },
    goToChapter(href) {
      return this.rendition?.display(href)
    },
    prev() {
      if (this.rendition) {
        this.rendition.prev()
      }
    },
    next() {
      if (this.rendition) {
        this.rendition.next()
      }
    },
    /**
     * @param {object} payload
     * @param {string} payload.ebookLocation - CFI of the current location
     * @param {string} payload.ebookProgress - eBook Progress Percentage
     */
    async updateProgress(payload) {
      if (!this.keepProgress) return

      // Update local item
      if (this.localLibraryItemId) {
        const localPayload = {
          localLibraryItemId: this.localLibraryItemId,
          ...payload
        }
        const localResponse = await this.$db.updateLocalEbookProgress(localPayload)
        if (localResponse.localMediaProgress) {
          this.$store.commit('globals/updateLocalMediaProgress', localResponse.localMediaProgress)
        }
      }

      // Update server item
      if (this.serverLibraryItemId) {
        this.$nativeHttp.patch(`/api/me/progress/${this.serverLibraryItemId}`, payload).catch((error) => {
          console.error('EpubReader.updateProgress failed:', error)
        })
      }
    },
    getAllEbookLocationData() {
      const locations = []
      let totalSize = 0 // Total in bytes

      for (const key in localStorage) {
        if (!localStorage.hasOwnProperty(key) || !key.startsWith('ebookLocations-')) {
          continue
        }

        try {
          const ebookLocations = JSON.parse(localStorage[key])
          if (!ebookLocations.locations) throw new Error('Invalid locations object')

          ebookLocations.key = key
          ebookLocations.size = (localStorage[key].length + key.length) * 2
          locations.push(ebookLocations)
          totalSize += ebookLocations.size
        } catch (error) {
          console.error('Failed to parse ebook locations', key, error)
          localStorage.removeItem(key)
        }
      }

      // Sort by oldest lastAccessed first
      locations.sort((a, b) => a.lastAccessed - b.lastAccessed)

      return {
        locations,
        totalSize
      }
    },
    /** @param {string} locationString */
    checkSaveLocations(locationString) {
      const maxSizeInBytes = 3000000 // Allow epub locations to take up to 3MB of space
      const newLocationsSize = JSON.stringify({ lastAccessed: Date.now(), locations: locationString }).length * 2

      // Too large overall
      if (newLocationsSize > maxSizeInBytes) {
        console.error('Epub locations are too large to store. Size =', newLocationsSize)
        return
      }

      const ebookLocationsData = this.getAllEbookLocationData()

      let availableSpace = maxSizeInBytes - ebookLocationsData.totalSize

      // Remove epub locations until there is room for locations
      while (availableSpace < newLocationsSize && ebookLocationsData.locations.length) {
        const oldestLocation = ebookLocationsData.locations.shift()
        console.log(`Removing cached locations for epub "${oldestLocation.key}" taking up ${oldestLocation.size} bytes`)
        availableSpace += oldestLocation.size
        localStorage.removeItem(oldestLocation.key)
      }

      console.log(`Cacheing epub locations with key "${this.localStorageLocationsKey}" taking up ${newLocationsSize} bytes`)
      this.saveLocations(locationString)
    },
    /** @param {string} locationString */
    saveLocations(locationString) {
      localStorage.setItem(
        this.localStorageLocationsKey,
        JSON.stringify({
          lastAccessed: Date.now(),
          locations: locationString
        })
      )
    },
    loadLocations() {
      const locationsObjString = localStorage.getItem(this.localStorageLocationsKey)
      if (!locationsObjString) return null

      const locationsObject = JSON.parse(locationsObjString)

      // Remove invalid location objects
      if (!locationsObject.locations) {
        console.error('Invalid epub locations stored', this.localStorageLocationsKey)
        localStorage.removeItem(this.localStorageLocationsKey)
        return null
      }

      // Update lastAccessed
      this.saveLocations(locationsObject.locations)

      return locationsObject.locations
    },
    /** @param {string} location - CFI of the new location */
    relocated(location) {
      console.log(`[EpubReader] relocated ${location.start.cfi}`)
      if (this.inittingDisplay) {
        console.log(`[EpubReader] relocated but initting display ${location.start.cfi}`)
        return
      }
      this.currentLocationNum = location.start.location

      if (this.currentLocationCfi === location.start.cfi) {
        console.log(`[EpubReader] location already saved`, location.start.cfi)
        return
      }

      console.log(`[EpubReader] Saving new location ${location.start.cfi}`)
      this.currentLocationCfi = location.start.cfi

      if (location.end.percentage) {
        this.updateProgress({
          ebookLocation: location.start.cfi,
          ebookProgress: location.end.percentage
        })
        this.progress = Math.round(location.end.percentage * 100)
      } else {
        this.updateProgress({
          ebookLocation: location.start.cfi
        })
      }
    },
    initEpub() {
      this.progress = Math.round((this.userItemProgress?.ebookProgress || 0) * 100)

      /** @type {EpubReader} */
      const reader = this

      // Use axios to make request because we have token refresh logic in interceptor
      const customRequest = async (url) => {
        try {
          return this.$axios.$get(url, {
            responseType: 'arraybuffer'
          })
        } catch (error) {
          console.error('EpubReader.initEpub customRequest failed:', error)
          throw error
        }
      }

      console.log('[EpubReader] initEpub', reader.url)
      /** @type {ePub.Book} */
      reader.book = new ePub(reader.url, {
        width: window.innerWidth,
        height: window.innerHeight - this.readerHeightOffset,
        openAs: 'epub',
        requestMethod: this.isLocal ? null : customRequest
      })

      /** @type {ePub.Rendition} */
      reader.rendition = reader.book.renderTo('viewer', {
        width: window.innerWidth,
        height: window.innerHeight - this.readerHeightOffset,
        snap: true,
        manager: 'continuous',
        flow: 'paginated'
      })

      reader.book.ready.then(() => {
        console.log('%c [EpubReader] Book ready', 'color:cyan;')

        let displayCfi = reader.book.locations.start
        if (this.savedEbookLocation && reader.book.spine.get(this.savedEbookLocation)) {
          displayCfi = this.savedEbookLocation
        }

        reader.rendition.on('displayed', async () => {
          console.log('%c [EpubReader] Rendition displayed', 'color:blue;')

          // Overriding the needsSnap function in epubjs `snap.js` to fix a bug with scrollLeft being a decimal
          reader.rendition.manager.snapper.needsSnap = function () {
            let left = Math.round(this.scrollLeft)
            let snapWidth = this.layout.pageWidth * this.layout.divisor
            return left % snapWidth !== 0
          }
        })

        reader.rendition.on('rendered', (section, view) => {
          this.applyTheme()
          console.log('%c [EpubReader] Rendition rendered', 'color:red;', section, view)
        })

        // set up event listeners
        reader.rendition.on('relocated', reader.relocated)

        reader.rendition.on('displayError', (err) => {
          console.log('[EpubReader] Display error', err)
        })

        reader.rendition.on('touchstart', (event) => {
          this.$emit('touchstart', event)
        })
        reader.rendition.on('touchend', (event) => {
          this.$emit('touchend', event)
        })

        // load ebook cfi locations
        const savedLocations = this.loadLocations()
        if (savedLocations) {
          reader.book.locations.load(savedLocations)
          this.totalLocations = reader.book.locations.length()
        } else {
          reader.book.locations.generate(100).then(() => {
            this.totalLocations = reader.book.locations.length()
            this.currentLocationNum = reader.rendition.currentLocation()?.start.location || 0
            this.checkSaveLocations(reader.book.locations.save())
          })
        }

        // TODO: To get the correct page need to render twice. On book ready and after first display. Figure out why
        console.log(`[EpubReader] Displaying cfi ${displayCfi}`)
        this.currentLocationCfi = displayCfi
        reader.rendition.display(displayCfi).then(() => {
          reader.rendition.display(displayCfi).then(() => {
            this.inittingDisplay = false
          })
        })
      })
    },
    applyTheme() {
      if (!this.rendition) return
      this.rendition.getContents().forEach((c) => {
        c.addStylesheetRules(this.themeRules)
      })
    },
    async screenOrientationChange() {
      if (this.isRefreshingUI) return
      this.isRefreshingUI = true
      const windowWidth = window.innerWidth
      this.refreshUI()

      // Window width does not always change right away. Wait up to 250ms for a change.
      // iPhone 10 on iOS 16 took between 100 - 200ms to update when going from portrait to landscape
      //   but landscape to portrait was immediate
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (window.innerWidth !== windowWidth) {
          this.refreshUI()
          break
        }
      }

      this.isRefreshingUI = false
    },
    onVisibilityChange() {
      if (!document.hidden) this.syncTtsOnResume()
    },
    refreshUI() {
      if (this.rendition?.resize) {
        this.rendition.resize(window.innerWidth, window.innerHeight - this.readerHeightOffset)
      }
    }
  },
  mounted() {
    this.initEpub()

    if (screen.orientation) {
      // Not available on ios
      screen.orientation.addEventListener('change', this.screenOrientationChange)
    } else {
      document.addEventListener('orientationchange', this.screenOrientationChange)
    }
    window.addEventListener('resize', this.screenOrientationChange)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
  },
  beforeDestroy() {
    if (this.ttsActive) this.stopTts()
    this.book?.destroy()

    if (screen.orientation) {
      // Not available on ios
      screen.orientation.removeEventListener('change', this.screenOrientationChange)
    } else {
      document.removeEventListener('orientationchange', this.screenOrientationChange)
    }
    window.removeEventListener('resize', this.screenOrientationChange)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
  }
}
</script>

<style>
#epub-frame {
  height: calc(100% - 32px);
  max-height: calc(100% - 32px);
  overflow: hidden;
}
.reader-player-open #epub-frame {
  height: calc(100% - 132px);
  max-height: calc(100% - 132px);
  overflow: hidden;
}
</style>
