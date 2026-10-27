<template>
  <div id="epub-frame" class="w-full">
    <div id="viewer" class="h-full w-full"></div>

    <div class="fixed left-0 h-8 w-full px-4 flex items-center" :class="isLightTheme ? 'bg-white text-black' : isDarkTheme ? 'bg-[#232323] text-white/80' : 'bg-black text-white/80'" :style="{ bottom: isPlayerOpen ? '120px' : '0px' }">
      <p v-if="totalLocations" class="text-xs text-slate-600">Location {{ currentLocationNum }} of {{ totalLocations }}</p>
      <div class="flex-grow" />
      <p class="text-xs">{{ progress }}%</p>
    </div>
  </div>
</template>

<script>
import ePub from 'epubjs'
import ttsSession from '@/utils/tts/ttsSession'
import { saveEbookProgress } from '@/utils/ebookProgress'

/** The status bar and navigation bar showing or hiding changes the window height by less than this */
const SYSTEM_BAR_CHANGE = 120
const MAX_PAGES_FROM_AUDIO = 1 // while read aloud runs, the reader may be this many pages from the sentence being read; further is pulled back
const PAGE_TURN_SETTLE_MS = 350
// A position is only saved once the reader has stayed on it this long. While epub.js lays out the chapters around the one shown
// it reports pages of the neighbouring chapters for a moment (a jump of 4 chapters was seen), and those must not become the saved position.
const SAVE_LOCATION_SETTLE_MS = 1500
const MAX_SETTLE_TRIES = 3 // snapping to a page the book cannot reach

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
      ttsHighlightCfi: null,
      ttsHandler: null,
      /** Turn the page to the sentence being read. Off after the listener turns the page themselves, until the sentence is on screen again */
      ttsFollowAlong: true,
      /** The size the book is laid out for. Laying it out again for a size it already has would move the page. */
      appliedSize: null,
      resizeTimer: null,
      /** Where the reader is, set by the reader moving (not by the book being laid out again): the book is put back here after a resize */
      readingCfi: null,
      relayoutUntil: 0,
      /** The position waiting to be saved (see SAVE_LOCATION_SETTLE_MS) */
      saveLocationTimer: null,
      pendingLocation: null,
      /**
       * The book was opened without a saved position (none yet, or the progress had not loaded): the page it opens at is the start
       * of the book, not where the listener is, so it is not saved until they move (or the saved position arrives and takes them there)
       */
      holdStartSave: false,
      startLocationCfi: null,
      /** A page turn to the sentence being read is on its way: the latest sentence waits for it */
      ttsDisplaying: false,
      ttsPendingCfi: null,
      ttsIgnoreRelocatedUntil: 0, // page turns we made ourselves, and the ones that follow opening the book, are not the listener turning the page
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
    /** The saved position arrived after the book opened at its start (the progress had not loaded): go there, it is not a position to save over */
    savedEbookLocation(cfi) {
      if (!cfi || !this.holdStartSave || !this.rendition || this.inittingDisplay) return
      if (this.startLocationCfi && this.currentLocationCfi !== this.startLocationCfi) return // the listener has moved on
      if (!this.book?.spine?.get(cfi)) return
      this.holdStartSave = false
      this.currentLocationCfi = cfi
      this.readingCfi = cfi
      this.rendition.display(cfi)
    },
    isPlayerOpen() {
      this.refreshUI()
    },
    /** Read aloud started (or was resumed after the app was reopened) while this reader is open: show what is being read */
    ttsRunning(running) {
      if (!running || this.inittingDisplay) return
      this.ttsFollowAlong = true
      this.attachTtsHandler()
      this.syncTtsOnResume()
    },
    /** Play pressed after the reader looked around while paused: back to the page being read */
    ttsPlaying(playing) {
      if (!playing || !this.ttsRunning || this.inittingDisplay || !this.rendition) return
      this.ttsFollowAlong = true
      const cfi = ttsSession.currentCfi
      const loc = this.rendition.currentLocation()
      if (cfi && !this.isTtsSentenceVisible(loc)) {
        this.ttsIgnoreRelocatedUntil = Date.now() + 1500
        this.rendition.display(cfi)
      }
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
      // The audiobook player or the read-aloud player is showing at the bottom
      return this.$store.getters['getIsPlayerOpen'] || this.$store.state.tts.active
    },
    readerHeightOffset() {
      return this.isPlayerOpen ? 204 : 104
    },
    /** Read aloud is speaking (not paused): only then the reader is kept near the sentence being read */
    ttsPlaying() {
      return !!this.$store.state.tts.playing
    },
    /** Native read aloud is running for this book */
    ttsRunning() {
      return this.ttsActive && !this.$store.state.tts.restored
    },
    /** Read-aloud is playing (or ready to be played, after the app was reopened) this book */
    ttsActive() {
      const tts = this.$store.state.tts
      if (!tts.active) return false
      // The downloaded copy and the server's copy of the same book have different ids
      return tts.libraryItemId === this.libraryItemId || (!!tts.serverLibraryItemId && tts.serverLibraryItemId === this.serverLibraryItemId) || (!!tts.localLibraryItemId && tts.localLibraryItemId === this.localLibraryItemId)
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
          '-webkit-text-stroke': this.ereaderSettings.textStroke / 100 + 'px ' + fontColor + '!important',
          // A word (or link) longer than the page is broken at the page edge instead of running off the screen
          'overflow-wrap': 'anywhere!important'
        },
        a: {
          color: `${fontColor}!important`
        }
      }
    }
  },
  methods: {
    /** ---- Text to speech: the session itself is global (utils/tts/ttsSession.js), the reader only highlights ---- */
    async toggleTts() {
      // Read from the top of the page being looked at, whether or not it is already reading this book: when it
      // is, it moves to this page instead of starting again. (Pause and play are on the player.)
      const startCfi = this.rendition?.currentLocation()?.start?.cfi || this.currentLocationCfi
      if (this.ttsRunning && startCfi) {
        this.ttsFollowAlong = true
        this.ttsIgnoreRelocatedUntil = Date.now() + 1500
        return ttsSession.readFrom(startCfi)
      }
      // Not reading this book yet, or a session restored after the app was closed that has nothing running
      return this.startTts()
    },
    async startTts() {
      if (!this.book || !this.rendition) return
      const startCfi = this.rendition.currentLocation()?.start?.cfi || this.currentLocationCfi
      // The session takes over the book so the text keeps being produced after the reader is closed
      this.attachTtsHandler()
      await ttsSession.start({
        book: this.book,
        bookFromReader: true,
        startCfi,
        meta: {
          libraryItem: this.libraryItem,
          localLibraryItem: this.localLibraryItem,
          url: this.url,
          isLocal: this.isLocal,
          serverLibraryItemId: this.serverLibraryItemId,
          localLibraryItemId: this.localLibraryItemId,
          keepProgress: this.keepProgress,
          progress: this.progress
        }
      })
    },
    attachTtsHandler() {
      if (this.ttsHandler) return
      this.ttsHandler = {
        onSentence: (data) => this.onTtsSentence(data),
        onStopped: () => this.clearTtsHighlight()
      }
      ttsSession.attachReader(this.ttsHandler)
    },
    /**
     * epub.js makes a new iframe every time a chapter is rendered again but keeps the highlight layer it made for the old one, which
     * stays tied to that detached iframe: it measures 0 x 0, so the layer is clipped away and the highlight is not shown (the text being
     * read is not marked). Point the layer at the current iframe and measure it again.
     */
    repairHighlightLayer() {
      try {
        this.rendition.views().forEach((view) => {
          const pane = view.pane
          if (pane && view.iframe && pane.target !== view.iframe) {
            pane.target = view.iframe
            pane.render()
          }
        })
      } catch (error) {
        console.warn('[EpubReader] failed to repair the highlight layer', error)
      }
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
    /**
     * Turns to the sentence being read. While a page turn is on its way only the latest sentence is kept: coming back after a long
     * time away the sentences arrive faster than the book can show them, and following each one scrolled through the whole stretch.
     */
    followTtsTo(cfi) {
      this.ttsPendingCfi = cfi
      if (this.ttsDisplaying) return
      this.ttsDisplaying = true
      const run = async () => {
        while (this.ttsPendingCfi) {
          const next = this.ttsPendingCfi
          this.ttsPendingCfi = null
          this.ttsIgnoreRelocatedUntil = Date.now() + 1500
          try {
            await this.rendition.display(next)
          } catch (error) {
            console.warn('[EpubReader] failed to follow the sentence', error)
          }
        }
        this.ttsDisplaying = false
      }
      run()
    },
    onTtsSentence({ cfi }) {
      if (!this.rendition || !cfi) return
      // The app is in the background: nothing is on screen to turn or mark. The position of the sentence is taken once, when
      // the app comes back (syncTtsOnResume)
      if (document.hidden) return
      this.clearTtsHighlight()
      try {
        this.rendition.annotations.highlight(cfi, {}, null, 'tts-highlight', { fill: 'yellow', 'fill-opacity': '0.35', 'mix-blend-mode': 'normal' })
        this.ttsHighlightCfi = cfi
      } catch (error) {
        console.warn('[EpubReader] failed to highlight', error)
      }
      this.repairHighlightLayer()
      const loc = this.rendition.currentLocation()
      if (loc?.start && loc?.end) {
        const compare = new ePub.CFI()
        const visible = compare.compare(cfi, loc.start.cfi) >= 0 && compare.compare(cfi, loc.end.cfi) <= 0
        if (visible) {
          this.ttsFollowAlong = true
        } else if (!this.ttsPlaying) {
          // Paused: the reader may be anywhere. Play brings them back (see the ttsPlaying watcher)
        } else if (this.ttsFollowAlong) {
          this.followTtsTo(cfi)
        } else if (this.ttsPageDistance(cfi, loc) > MAX_PAGES_FROM_AUDIO) {
          // The reader looked away and the audio has moved on until it is further away than a page: back to the audio
          this.returnToTtsPage(cfi)
        }
      }
    },
    /**
     * How many pages the sentence being read is from the pages on screen: 0 when it is on them, 1 on the next or the previous page.
     * Measured in the book's locations (a fixed amount of text each) against the size of the pages on screen, so it also works across
     * chapters. null when it cannot be told (locations not generated yet).
     */
    ttsPageDistance(cfi, loc) {
      const locations = this.book?.locations
      if (!cfi || !loc?.start || !loc?.end || !locations?.length()) return null
      const first = locations.locationFromCfi(loc.start.cfi)
      const last = locations.locationFromCfi(loc.end.cfi)
      const spoken = locations.locationFromCfi(cfi)
      if (![first, last, spoken].every((n) => typeof n === 'number' && n >= 0)) return null
      const page = Math.max(1, last - first + 1)
      if (spoken < first) return (first - spoken) / page
      if (spoken > last) return (spoken - last) / page
      return 0
    },
    /** The reader is more than a page from the audio: bring them back to the page it is on */
    returnToTtsPage(cfi) {
      console.log('[EpubReader] more than a page from the audio, returning to', cfi)
      this.ttsFollowAlong = true
      this.ttsIgnoreRelocatedUntil = Date.now() + 1500
      this.rendition.display(cfi)
      this.$toast.info(this.$strings.MessageTtsBackToPage)
    },
    /** Is the sentence being read on the page `location` (from epub.js's relocated event) */
    isTtsSentenceVisible(location) {
      const cfi = ttsSession.currentCfi
      if (!cfi || !location?.start || !location?.end) return true
      const compare = new ePub.CFI()
      return compare.compare(cfi, location.start.cfi) >= 0 && compare.compare(cfi, location.end.cfi) <= 0
    },
    async syncTtsOnResume() {
      if (!this.ttsActive) return
      const state = await ttsSession.getState()
      if (state.active && state.currentCfi) this.onTtsSentence({ cfi: state.currentCfi })
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
      await saveEbookProgress(this, { localLibraryItemId: this.localLibraryItemId, serverLibraryItemId: this.serverLibraryItemId }, payload)
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
      // A page turn the listener made while read aloud is running: stop pulling them back to the sentence being read
      if (this.ttsRunning && this.ttsPlaying && !this.inittingDisplay && Date.now() > this.ttsIgnoreRelocatedUntil && !this.isTtsSentenceVisible(location)) {
        // The listener moved to a page that does not have the sentence being read: stop pulling them back to it
        this.ttsFollowAlong = false
        // ...unless that is further than a page from it: the audio and the reader must not drift apart
        const cfi = ttsSession.currentCfi
        if (this.ttsPageDistance(cfi, location) > MAX_PAGES_FROM_AUDIO) {
          setTimeout(() => this.returnToTtsPage(cfi), PAGE_TURN_SETTLE_MS) // let the page turn finish first
          return
        }
      }
      if (this.inittingDisplay) {
        console.log(`[EpubReader] relocated but initting display ${location.start.cfi}`)
        return
      }
      this.currentLocationNum = location.start.location
      // A page shown because the book was laid out again at another size is not where the reader was: laying out
      // again from it would move on from there every time the window changed size and came back
      if (Date.now() > this.relayoutUntil) this.readingCfi = location.start.cfi

      if (this.currentLocationCfi === location.start.cfi && !this.pendingLocation) {
        console.log(`[EpubReader] location already saved`, location.start.cfi)
        return
      }
      this.pendingLocation = { cfi: location.start.cfi, percentage: location.end.percentage }
      clearTimeout(this.saveLocationTimer)
      this.saveLocationTimer = setTimeout(() => this.saveLocationNow(), SAVE_LOCATION_SETTLE_MS)
    },
    /**
     * Saves where the reader is, once it has stayed there. The position is read again from epub.js at this point: whatever was
     * reported on the way (see SAVE_LOCATION_SETTLE_MS) is not what is saved.
     */
    saveLocationNow() {
      clearTimeout(this.saveLocationTimer)
      const pending = this.pendingLocation
      this.pendingLocation = null
      if (!pending || this.inittingDisplay || !this.rendition) return
      const live = this.rendition.currentLocation()
      const cfi = live?.start?.cfi || pending.cfi
      const percentage = live?.end?.percentage || pending.percentage

      if (this.holdStartSave) {
        // Still on the page the book opened at without a saved position: nothing to save yet
        if (!this.startLocationCfi) this.startLocationCfi = cfi
        if (this.startLocationCfi === cfi) return
        this.holdStartSave = false
      }
      if (this.currentLocationCfi === cfi) return

      console.log(`[EpubReader] Saving new location ${cfi}`)
      this.currentLocationCfi = cfi

      if (percentage) {
        this.updateProgress({
          ebookLocation: cfi,
          ebookProgress: percentage
        })
        this.progress = Math.round(percentage * 100)
      } else {
        this.updateProgress({
          ebookLocation: cfi
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
      this.appliedSize = { width: window.innerWidth, height: window.innerHeight - this.readerHeightOffset }
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
        } else if (this.keepProgress) {
          // No saved position: opening at the start of the book must not overwrite one that has not loaded yet
          this.holdStartSave = true
        }
        // Read aloud is running for this book: open where it is reading now, not at the last saved position
        const ttsCfi = this.ttsActive ? ttsSession.currentCfi : null
        if (ttsCfi && reader.book.spine.get(ttsCfi)) {
          displayCfi = ttsCfi
          this.holdStartSave = false
        }

        reader.rendition.on('displayed', async () => {
          console.log('%c [EpubReader] Rendition displayed', 'color:blue;')

          // Overriding the needsSnap function in epubjs `snap.js` to fix a bug with scrollLeft being a decimal
          reader.rendition.manager.snapper.needsSnap = function () {
            let left = Math.round(this.scrollLeft)
            let snapWidth = this.layout.pageWidth * this.layout.divisor
            return left % snapWidth !== 0
          }
          this.installStickyPages()
        })

        reader.rendition.on('rendered', (section, view) => {
          this.applyTheme()
          console.log('%c [EpubReader] Rendition rendered', 'color:red;', section, view)
        })

        reader.rendition.started.then(() => this.guardManagerResize())

        // set up event listeners
        reader.rendition.on('relocated', reader.relocated)
        // A chapter rendered again gets its highlights back on a stale layer: fix it once they are in
        reader.rendition.on('rendered', () => setTimeout(() => reader.repairHighlightLayer(), 50))

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
        this.readingCfi = displayCfi
        reader.rendition.display(displayCfi).then(() => {
          reader.rendition.display(displayCfi).then(() => {
            this.inittingDisplay = false
            // Read-aloud may already be running for this book (reader was closed and reopened)
            if (this.ttsActive) {
              this.ttsIgnoreRelocatedUntil = Date.now() + 1500
              this.attachTtsHandler()
              // Playing: the sentence being read. Only restored after the app was reopened: the one it stopped at
              if (this.ttsRunning) this.syncTtsOnResume()
              else if (ttsSession.currentCfi) this.onTtsSentence({ cfi: ttsSession.currentCfi })
            }
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
    screenOrientationChange() {
      this.scheduleResize()
    },
    onVisibilityChange() {
      // Going to the background: the app may be closed without coming back, so the position waiting to be saved is saved now
      if (document.hidden) this.saveLocationNow()
      // Coming back from the recents screen the window passes through a few sizes: wait for the final one
      if (!document.hidden) {
        this.scheduleResize()
        this.syncTtsOnResume()
      }
    },
    /** The window changed size. It may change again straight away (the status bar, the recents screen), so wait for it to settle. */
    /**
     * Pages are sticky: a swipe turns exactly one page, whatever the speed or length, and the book always comes to
     * rest on a whole page. epub.js's own snapping adds a page to wherever the drag has already got to (a long drag turns
     * two) and gives up when a new touch starts while it is settling (which leaves the book between two pages).
     */
    installStickyPages() {
      const snap = this.rendition?.manager?.snapper
      if (!snap || snap.sticky || !snap.supportsTouch) return
      snap.sticky = true
      const MIN_DISTANCE = 40 // px of finger movement that turns the page
      const MIN_VELOCITY = 0.25 // px/ms: a short flick turns it too
      const DURATION = 220
      const pageWidth = () => snap.manager.layout.pageWidth * snap.manager.layout.divisor
      const position = () => (snap.fullsize ? window.scrollX : snap.scroller.scrollLeft)
      const ease = (t) => 1 - Math.pow(1 - t, 3)
      snap.touching = false
      snap.animFrame = null
      snap.targetLeft = null
      snap.startPage = null

      // Settles at once where the page was heading (a new touch has started while it was turning)
      snap.finishAnimation = function () {
        if (this.animFrame === null) return
        cancelAnimationFrame(this.animFrame)
        this.animFrame = null
        this.scrollTo(this.targetLeft, 0)
        this.snapping = false
      }
      snap.animateTo = function (left) {
        if (this.animFrame !== null) cancelAnimationFrame(this.animFrame)
        this.animFrame = null
        const from = position()
        this.targetLeft = left
        if (Math.abs(left - from) < 1) {
          this.scrollTo(left, 0)
          this.snapping = false
          return
        }
        this.snapping = true
        const started = this.now()
        const tick = () => {
          const t = Math.min(1, (this.now() - started) / DURATION)
          this.scrollTo(from + (left - from) * ease(t), 0)
          if (t < 1) {
            this.animFrame = requestAnimationFrame(tick)
          } else {
            this.animFrame = null
            this.snapping = false
          }
        }
        tick()
      }

      snap.onTouchStart = function (e) {
        const { screenX, screenY } = e.touches[0]
        this.finishAnimation()
        this.touching = true
        this.settleTarget = null
        if (this.startTouchX === undefined) {
          this.startTouchX = screenX
          this.startTouchY = screenY
          this.startTime = this.now()
          // The page this touch started on: it can turn to the next or the previous one and no further
          this.startPage = Math.round(position() / pageWidth())
        }
        this.endTouchX = screenX
        this.endTouchY = screenY
        this.endTime = this.now()
      }

      snap.onTouchMove = function (e) {
        const { screenX, screenY } = e.touches[0]
        if (!this.fullsize && Math.abs(screenY - this.endTouchY) < 10 && this.startPage !== null) {
          // The page follows the finger, but never further than one page from where it started
          const width = pageWidth()
          const left = this.element.scrollLeft - (screenX - this.endTouchX)
          this.element.scrollLeft = Math.min((this.startPage + 1) * width, Math.max((this.startPage - 1) * width, left))
        }
        this.endTouchX = screenX
        this.endTouchY = screenY
        this.endTime = this.now()
      }

      snap.onTouchEnd = function () {
        this.touching = false
        const width = pageWidth()
        const startPage = this.startPage !== null ? this.startPage : Math.round(position() / width)
        let page = startPage
        if (this.startTouchX !== undefined) {
          const distance = this.endTouchX - this.startTouchX
          const sideways = Math.abs(distance) > Math.abs(this.endTouchY - this.startTouchY)
          const velocity = distance / Math.max(1, this.endTime - this.startTime)
          if (sideways && (Math.abs(distance) >= MIN_DISTANCE || (Math.abs(distance) > 10 && Math.abs(velocity) > MIN_VELOCITY))) {
            page += distance < 0 ? 1 : -1
          }
        }
        this.animateTo(Math.max(0, page * width))
        this.startTouchX = this.startTouchY = this.startTime = undefined
        this.endTouchX = this.endTouchY = this.endTime = undefined
        this.startPage = null
      }

      snap.onScroll = function () {
        this.scrollLeft = position()
        this.scrollTop = this.fullsize ? window.scrollY : this.scroller.scrollTop
        // Whatever moved the book (a cancelled touch, the keyboard, a resize), it does not stay between two pages
        clearTimeout(this.settleTimer)
        this.settleTimer = setTimeout(() => {
          if (this.touching || this.animFrame !== null) return
          const width = pageWidth()
          const left = position()
          const nearest = Math.max(0, Math.round(left / width) * width)
          if (Math.abs(left - nearest) <= 1.5) {
            this.settleTries = 0
            return
          }
          // A position the book cannot scroll to (past the end of what is laid out so far, while the next chapter is still loading) stays
          // where it is however often it is asked: every try scrolls on every frame and reports a new location. Give up after a few.
          if (this.settleTarget === nearest) this.settleTries++
          else {
            this.settleTarget = nearest
            this.settleTries = 1
          }
          if (this.settleTries <= MAX_SETTLE_TRIES) this.animateTo(nearest)
        }, 160)
      }

      // The handlers are bound when the listeners are added: add them again so these are the ones used
      snap.removeListeners()
      snap.addListeners()
    },
    /**
     * epub.js listens for window resizes itself, reads the size from the page (which follows the window, status bar
     * and all) and lays the book out again at once: at every size the window passes through. Its own calls are turned
     * into a scheduled check instead, and only `refreshUI` lays the book out, and only for a size it does not have yet.
     */
    guardManagerResize() {
      const manager = this.rendition?.manager
      if (!manager || manager.guarded) return
      const resize = manager.resize.bind(manager)
      manager.guarded = true
      manager.resize = (width, height, epubcfi) => {
        if (width === undefined && height === undefined && !this.applyingSize) {
          this.scheduleResize()
          return
        }
        return resize(width, height, epubcfi)
      }
    },
    scheduleResize() {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => this.refreshUI({ fromWindow: true }), 350)
    },
    refreshUI({ fromWindow = false } = {}) {
      // epub.js only creates the manager once the book has opened: a resize before that has nothing to resize
      if (!this.rendition?.manager || document.hidden) return
      const size = { width: window.innerWidth, height: window.innerHeight - this.readerHeightOffset }
      // The window got a little taller or shorter (the status bar and the navigation bar come and go, the recents screen
      // shows them): the layout is kept. The book is laid out in columns from its top, so laying it out for a new height
      // flows all of it again and moves the page; kept as it is, only the bottom edge is covered or uncovered.
      if (fromWindow && this.appliedSize && size.width === this.appliedSize.width && Math.abs(size.height - this.appliedSize.height) <= SYSTEM_BAR_CHANGE) return
      // The same size again: laying the book out again moves the page (the first line of a page can fall onto the one before)
      if (this.appliedSize && this.appliedSize.width === size.width && this.appliedSize.height === size.height) return
      this.appliedSize = size
      this.applyingSize = true
      this.relayoutUntil = Date.now() + 1500
      try {
        // Re-anchor on where the reader was, so that coming back to the first size shows the first page again
        this.rendition.resize(size.width, size.height, this.readingCfi || undefined)
      } finally {
        this.applyingSize = false
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
    clearTimeout(this.resizeTimer)
    this.saveLocationNow()
    // Read-aloud keeps playing after the reader is closed: the session owns the book
    if (this.ttsHandler) ttsSession.detachReader(this.ttsHandler)
    // Only the views are torn down: rendition.destroy() would clear rendition.book which epub.js hooks still use while the session reads
    // (A restored session has not opened a book: nothing else uses this one)
    if (this.ttsActive && !this.$store.state.tts.restored) this.rendition?.manager?.destroy()
    else this.book?.destroy()

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
