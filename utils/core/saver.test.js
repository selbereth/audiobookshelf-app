import assert from 'assert'
import { saverModule, TICK_MS } from './modules/saver'
import { tickModule } from './modules/tick'
import * as rules from './modules/dbRules'

// Every rule below names the Kotlin it ports (MediaProgressSyncer.kt unless shown). The Kotlin is not run here.
const T0 = 1_000_000
const clone = (o) => JSON.parse(JSON.stringify(o))

// Fake native (player, timer, system, session connectors) and the JS modules around the saver
function setup({ net = { connected: true, metered: false }, store = {}, native = {}, legacy = false, timeoutMs = 5, coreSaver = true } = {}) {
  const clock = { t: T0 }
  const ctl = { serverError: null, localError: null, closeError: null, serverId: 'c1' }
  const nat = { playing: true, positionSec: 0, sessionId: 'ps1', silent: false, live: true, ...native }
  const handlers = new Map()
  const calls = []
  const alerts = []
  const logs = []
  const events = []
  const sent = { session: [], local: [], close: [] }
  let lastAt = null
  let netNow = net // what system.network answers (native's current network)
  const bridge = {
    call(connector, method, args) {
      calls.push({ connector, method, args })
      if (connector === 'system' && method === 'flags') {
        return coreSaver === 'error' ? Promise.reject(new Error('no answer')) : Promise.resolve({ coreSaver })
      }
      if (connector === 'system' && method === 'network') return Promise.resolve(netNow)
      if (connector === 'timer') {
        if (method === 'schedule') lastAt = args.atMs
        return Promise.resolve({ ok: true })
      }
      if (connector === 'player' && method === 'getPosition') {
        if (nat.silent) return new Promise(() => {})
        return Promise.resolve({ playing: nat.playing, positionSec: nat.positionSec, sessionId: nat.sessionId, rate: 1, atMs: clock.t })
      }
      if (connector === 'player' && method === 'getState') {
        return Promise.resolve({ live: nat.live, playing: nat.playing, positionSec: nat.positionSec, sessionId: nat.sessionId, rate: 1, session: nat.session ?? null })
      }
      return Promise.reject(new Error('unexpected ' + connector + '.' + method))
    },
    on(connector, event, h) {
      const k = connector + '/' + event
      if (!handlers.has(k)) handlers.set(k, new Set())
      handlers.get(k).add(h)
      return () => handlers.get(k).delete(h)
    },
    serve() {}
  }
  const fire = (connector, event, data, t) => {
    for (const h of [...(handlers.get(connector + '/' + event) || [])]) h(data, t)
  }
  const tick = tickModule(bridge, { now: () => clock.t })
  const progress = {
    async sendSession(a) { sent.session.push(clone(a)); return ctl.serverError ? { error: ctl.serverError } : {} },
    async sendLocalSession(a) { sent.local.push(clone(a)); return ctl.localError ? { error: ctl.localError } : {} },
    async closeSession(a) { sent.close.push(clone(a)); return ctl.closeError ? { error: ctl.closeError } : {} }
  }
  // The store: JSON in and out, as the store connector does
  const db = {
    serial: (fn) => fn(),
    store: {
      get: async (c, k) => (store[c] && store[c][k] !== undefined ? clone(store[c][k]) : null),
      list: async (c) => Object.values(store[c] || {}).map(clone),
      put: async (c, k, v) => { (store[c] ||= {})[k] = clone(v) },
      delete: async (c, k) => { delete (store[c] || {})[k] }
    },
    addPlaybackEvent: async (name, s, r) => { events.push({ name, currentTime: s.currentTime, timeListening: s.timeListening, r: r ? clone(r) : null }) },
    methods: { getDeviceData: async () => ({ lastServerConnectionConfigId: ctl.serverId }) }
  }
  const saver = saverModule(bridge, {
    progress, db, tick, now: () => clock.t, log: (m) => logs.push(m), alert: (k) => alerts.push(k),
    emit: () => {}, legacyTimeListening: legacy, positionTimeoutMs: timeoutMs
  })
  saver.start()
  fire('system', 'network', net)
  const t = {
    clock, ctl, native: nat, store, sent, alerts, events, logs, calls, saver,
    idle: () => saver.idle(),
    // A native event at time `at` (default: now)
    state: (d, at = clock.t) => fire('player', 'state', d, at),
    opened: (session) => fire('session', 'opened', { session }, clock.t),
    net: (n) => { netNow = n; fire('system', 'network', n, clock.t) },
    // The 15 s tick fires at `at` (the time native fired it); the core asked for `lastAt`
    tickAt: (at) => { clock.t = at; fire('timer', 'tick', { id: 'progress', atMs: lastAt }, at) },
    schedules: () => calls.filter((c) => c.connector === 'timer' && c.method === 'schedule').map((c) => c.args),
    cancels: () => calls.filter((c) => c.connector === 'timer' && c.method === 'cancel'),
    lastSave: () => events.filter((e) => e.name === 'Save').at(-1)
  }
  return t
}

const book = (over = {}) => ({
  id: 'ps1', userId: 'u1', libraryItemId: 'li-1', episodeId: null, localLibraryItemId: null, localEpisodeId: null, mediaType: 'book',
  displayTitle: 'Book', displayAuthor: 'Author', duration: 100, playMethod: 0, startedAt: 1, updatedAt: 0, timeListening: 0, currentTime: 0,
  serverConnectionConfigId: 'c1', serverAddress: 'https://s', mediaPlayer: 'exo', audioTracks: [{ duration: 100 }], deviceInfo: { deviceId: 'd' },
  ...over
})
// A local book linked to the server item (playMethod 3 = PLAYMETHOD_LOCAL)
const linked = (over = {}) => book({ id: 'ps-loc', playMethod: 3, localLibraryItemId: 'loc-1', ...over })
const playing = async (t, at = T0) => {
  t.state({ reason: 'playing', sessionId: t.native.sessionId, playing: true, positionSec: t.native.positionSec }, at)
  await t.idle()
}
const paused = (t, positionSec, at) => t.state({ reason: 'paused', sessionId: t.native.sessionId, playing: false, positionSec }, at)
const UNMETERED = { connected: true, metered: false }
const METERED = { connected: true, metered: true }
const OFFLINE = { connected: false, metered: false }

const tests = {
  async 'the tick is asked every 15 s while playing and cancelled on pause (MediaProgressSyncer.kt:79, :146-151)'() {
    const t = setup()
    t.opened(book())
    await playing(t)
    await t.idle()
    assert.deepStrictEqual(t.schedules().at(-1), { id: 'progress', atMs: T0 + TICK_MS })
    t.native.positionSec = 20
    paused(t, 20, T0 + 20000)
    await t.idle()
    assert.strictEqual(t.cancels().length, 1)
  },

  async 'success: a tick sends the seconds listened, counts them, and removes the saved row (:232-239, :301-308)'() {
    const t = setup()
    t.opened(book())
    await playing(t)
    t.native.positionSec = 15
    t.tickAt(T0 + 15000)
    await t.idle()
    assert.deepStrictEqual(t.sent.session, [{ sessionId: 'ps1', syncData: { timeListened: 15, duration: 100, currentTime: 15 } }])
    assert.strictEqual((t.store.playbackSession || {}).ps1, undefined)
    assert.deepStrictEqual(t.alerts, ['success'])
    assert.deepStrictEqual(t.lastSave(), { name: 'Save', currentTime: 15, timeListening: 15, r: { serverSyncAttempted: true, serverSyncSuccess: true, serverSyncMessage: null } })
    assert.strictEqual(t.store.openSession.ps1.unsentSec, 0)
  },

  async 'server error: the row stays saved, the seconds stay unsent and go with the next success; the alert comes at the second failure (:276-292, :301-318)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.ctl.serverError = 'Failed to connect'
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    assert.ok(t.store.playbackSession.ps1, 'the row is kept for the upload later (sync.js)')
    assert.deepStrictEqual(t.alerts, [])
    t.native.positionSec = 30; t.tickAt(T0 + 30000); await t.idle()
    assert.strictEqual(t.sent.session[1].syncData.timeListened, 30, 'the second failed send still carries the first 15 s')
    assert.deepStrictEqual(t.alerts, ['failing'])
    t.native.positionSec = 45; t.tickAt(T0 + 45000); await t.idle()
    assert.deepStrictEqual(t.alerts, ['failing'], 'the counter started again: one failure is not an alert')
    t.ctl.serverError = null
    t.native.positionSec = 60; t.tickAt(T0 + 60000); await t.idle()
    assert.strictEqual(t.sent.session[3].syncData.timeListened, 60)
    assert.deepStrictEqual(t.alerts, ['failing', 'success'])
    assert.strictEqual((t.store.playbackSession || {}).ps1, undefined)
  },

  async 'no connection: nothing is sent, the row is saved and the time counts; the next connected tick sends all of it (:253, :298)'() {
    const t = setup({ net: OFFLINE })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    t.native.positionSec = 30; t.tickAt(T0 + 30000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [])
    assert.strictEqual(t.store.playbackSession.ps1.timeListening, 30)
    assert.deepStrictEqual(t.alerts, [])
    t.net(UNMETERED)
    t.native.positionSec = 45; t.tickAt(T0 + 45000); await t.idle()
    assert.deepStrictEqual(t.sent.session[0].syncData, { timeListened: 45, duration: 100, currentTime: 45 })
  },

  async 'core restart mid-session: the open session is read back and continues without counting twice (player.getState)'() {
    const first = setup({ net: OFFLINE })
    first.opened(book())
    await playing(first)
    first.native.positionSec = 15; first.tickAt(T0 + 15000); await first.idle()
    // The core dies; the native player keeps playing. A new core reads the open record back.
    const second = setup({ net: UNMETERED, store: first.store, native: { positionSec: 15, playing: true } })
    second.clock.t = T0 + 15000
    await second.saver.restore()
    assert.deepStrictEqual(second.saver.snapshot(), { sessionId: 'ps1', running: true, unsentSec: 15, failedSyncs: 0 })
    second.native.positionSec = 30; second.tickAt(T0 + 30000); await second.idle()
    assert.deepStrictEqual(second.sent.session[0].syncData, { timeListened: 30, duration: 100, currentTime: 30 }, 'the first 15 s are sent once')
    assert.strictEqual(second.lastSave().timeListening, 30)
  },

  async 'a restart while paused restores the session and does not start the window'() {
    const t = setup({ native: { playing: false, positionSec: 40 } })
    t.store.openSession = { ps1: { session: book({ timeListening: 40, currentTime: 40 }), unsentSec: 0 } }
    await t.saver.restore()
    assert.deepStrictEqual(t.saver.snapshot(), { sessionId: 'ps1', running: false, unsentSec: 0, failedSyncs: 0 })
    assert.deepStrictEqual(t.schedules(), [])
  },

  async 'pause and resume: the paused time is not counted; the pause sends what was listened (:146-179, :53-71)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 20
    paused(t, 20, T0 + 20000); await t.idle()
    assert.deepStrictEqual(t.sent.session[0].syncData, { timeListened: 20, duration: 100, currentTime: 20 })
    assert.strictEqual(t.events.at(-1).name, 'Pause')
    await playing(t, T0 + 100000); await t.idle()
    t.native.positionSec = 35; t.tickAt(T0 + 115000); await t.idle()
    assert.deepStrictEqual(t.sent.session[1].syncData, { timeListened: 15, duration: 100, currentTime: 35 }, '80 s of pause are not in the send')
    assert.strictEqual(t.lastSave().timeListening, 35)
  },

  async 'seek while playing: the position is copied, a Seek event is written, nothing is sent; the next tick saves it (:200-210)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.state({ reason: 'seeked', sessionId: 'ps1', playing: true, positionSec: 40 }, T0 + 5000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [])
    assert.deepStrictEqual(t.events.at(-1), { name: 'Seek', currentTime: 40, timeListening: 0, r: null })
    t.native.positionSec = 41; t.tickAt(T0 + 15000); await t.idle()
    assert.deepStrictEqual(t.sent.session[0].syncData, { timeListened: 15, duration: 100, currentTime: 41 })
  },

  async 'seek while paused starts no counting window (Kotlin play() after a seek would, PlayerListener.kt:31-34)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 20
    paused(t, 20, T0 + 20000); await t.idle()
    const schedulesBefore = t.schedules().length
    t.state({ reason: 'seeked', sessionId: 'ps1', playing: false, positionSec: 50 }, T0 + 30000); await t.idle()
    assert.strictEqual(t.schedules().length, schedulesBefore, 'no tick is asked while paused')
    await playing(t, T0 + 100000); await t.idle()
    t.native.positionSec = 65; t.tickAt(T0 + 115000); await t.idle()
    assert.deepStrictEqual(t.sent.session[1].syncData, { timeListened: 15, duration: 100, currentTime: 65 })
  },

  async 'end of book: the end pauses at the end position and the local progress is finished (:146-179; LocalMediaProgress.kt:48-49)'() {
    const t = setup({ net: UNMETERED, native: { sessionId: 'ps-loc' } })
    t.opened(linked())
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    assert.strictEqual(t.store.localMediaProgress['loc-1'].isFinished, false)
    t.state({ reason: 'ended', sessionId: 'ps-loc', playing: false, positionSec: 100 }, T0 + 100000); await t.idle()
    const lp = t.store.localMediaProgress['loc-1']
    assert.strictEqual(lp.isFinished, true)
    assert.strictEqual(lp.progress, 1)
    assert.strictEqual(lp.finishedAt, lp.lastUpdate)
    assert.strictEqual(t.events.at(-1).name, 'Pause', 'Kotlin: the end is a pause (finished() finds the timer stopped)')
  },

  async 'the 0.99 finished rule is at 0.99 and not below (LocalMediaProgress.kt:48)'() {
    assert.strictEqual(rules.isFinishedByProgress(0.989), false)
    assert.strictEqual(rules.isFinishedByProgress(0.99), true)
    assert.strictEqual(rules.isFinishedByProgress(NaN), false)
    const s = linked({ currentTime: 98.9, updatedAt: 5 })
    assert.strictEqual(rules.applyPlaybackSession({ isFinished: false, finishedAt: null }, s).isFinished, false)
    const done = rules.applyPlaybackSession({ isFinished: false, finishedAt: null }, { ...s, currentTime: 99 })
    assert.deepStrictEqual([done.isFinished, done.finishedAt, done.progress], [true, 5, 0.99])
  },

  async 'a new local row is saved not finished even at 100% (PlaybackSession.kt:428-448; the next save applies the rule)'() {
    const t = setup({ net: OFFLINE, native: { sessionId: 'ps-loc' } })
    t.opened(linked())
    await playing(t)
    t.state({ reason: 'ended', sessionId: 'ps-loc', playing: false, positionSec: 100 }, T0 + 100000); await t.idle()
    assert.strictEqual(t.store.localMediaProgress['loc-1'].progress, 1)
    assert.strictEqual(t.store.localMediaProgress['loc-1'].isFinished, false, 'kept from Kotlin; open question')
  },

  async 'rapid events: a second playing does not restart the window, a second pause does nothing, a play and pause in one ms count nothing (:62-64, :147)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    await playing(t, T0 + 1000)
    t.native.positionSec = 3
    paused(t, 3, T0 + 3000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [{ sessionId: 'ps1', syncData: { timeListened: 3, duration: 100, currentTime: 3 } }])
    paused(t, 3, T0 + 3000); await t.idle()
    assert.strictEqual(t.sent.session.length, 1)
    await playing(t, T0 + 3000); paused(t, 3, T0 + 3000); await t.idle()
    assert.strictEqual(t.sent.session.length, 1, 'no second sync within the same second')
    assert.strictEqual(t.events.filter((e) => e.name === 'Pause').at(-1).r, null)
  },

  async 'the 1 s rule: a pause less than 1 s after a tick sends nothing; the time is counted from the resume (:232-235)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    t.native.positionSec = 15.4
    paused(t, 15.4, T0 + 15400); await t.idle()
    assert.strictEqual(t.sent.session.length, 1)
    await playing(t, T0 + 20000)
    t.native.positionSec = 30; t.tickAt(T0 + 35000); await t.idle()
    assert.deepStrictEqual(t.sent.session[1].syncData, { timeListened: 15, duration: 100, currentTime: 30 })
  },

  async 'metered: a tick is not sent before 60 s since the last send; the 60 s one sends everything (:87-90)'() {
    const t = setup({ net: METERED })
    t.opened(book())
    await playing(t)
    for (const s of [15, 30, 45]) { t.native.positionSec = s; t.tickAt(T0 + s * 1000); await t.idle() }
    assert.deepStrictEqual(t.sent.session, [])
    assert.strictEqual(t.store.playbackSession.ps1.timeListening, 45)
    t.native.positionSec = 60; t.tickAt(T0 + 60000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [{ sessionId: 'ps1', syncData: { timeListened: 60, duration: 100, currentTime: 60 } }])
  },

  async 'a tick at position 0 is skipped and the time counts at the next tick (:93)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 0; t.tickAt(T0 + 15000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [])
    assert.strictEqual(t.events.length, 1, 'only the Play event: a skipped tick writes no Save')
    t.native.positionSec = 30; t.tickAt(T0 + 30000); await t.idle()
    assert.deepStrictEqual(t.sent.session[0].syncData, { timeListened: 30, duration: 100, currentTime: 30 })
  },

  async 'total duration 0: the Kotlin NaN guard (:241-247) only catches 0/0, which cannot reach sync() (position 0 is skipped, :93); 15 s over 0 is Infinity and is saved (quirk, open question)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book({ duration: 0, audioTracks: [] }))
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    assert.strictEqual(t.sent.session.length, 1)
    assert.strictEqual(t.sent.session[0].syncData.duration, 0)
  },

  async 'local session: the local progress is saved on every tick; sent to the linked server only when connected, same server and linked (:255-296)'() {
    const t = setup({ net: UNMETERED, native: { sessionId: 'ps-loc' } })
    t.opened(linked())
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    const lp = t.store.localMediaProgress['loc-1']
    assert.deepStrictEqual([lp.currentTime, lp.progress, lp.isFinished, lp.serverConnectionConfigId], [15, 0.15, false, 'c1'])
    assert.strictEqual(t.sent.local.length, 1)
    assert.strictEqual(t.sent.local[0].session.id, 'ps-loc')
    assert.strictEqual(t.alerts.at(-1), 'success')
    assert.strictEqual((t.store.playbackSession || {})['ps-loc'], undefined, 'removed after the send (:280)')

    t.net(OFFLINE)
    t.native.positionSec = 30; t.tickAt(T0 + 30000); await t.idle()
    assert.strictEqual(t.sent.local.length, 1)
    assert.strictEqual(t.store.localMediaProgress['loc-1'].currentTime, 30, 'saved locally while offline')
    assert.ok(t.store.playbackSession['ps-loc'], 'kept for sync.js')

    t.net(UNMETERED); t.ctl.serverId = 'c2'
    t.native.positionSec = 45; t.tickAt(T0 + 45000); await t.idle()
    assert.strictEqual(t.sent.local.length, 1, 'another server: not sent (:270-275)')

    t.ctl.serverId = 'c1'
    const u = setup({ net: UNMETERED, native: { sessionId: 'ps-loc' } })
    u.opened(linked({ libraryItemId: null }))
    await playing(u)
    u.native.positionSec = 15; u.tickAt(T0 + 15000); await u.idle()
    assert.strictEqual(u.sent.local.length, 0, 'not linked to a server item: not sent (:273)')
  },

  async 'closing a server session stops with a sync and closes it on the server; after an error it does not sync but still closes (:114-144, :1042-1066)'() {
    const t = setup({ net: UNMETERED })
    t.opened(book())
    await playing(t)
    t.native.positionSec = 15; t.tickAt(T0 + 15000); await t.idle()
    t.state({ reason: 'closed', sessionId: 'ps1', playing: false, positionSec: 20, error: false }, T0 + 20000); await t.idle()
    assert.deepStrictEqual(t.sent.session[1].syncData, { timeListened: 5, duration: 100, currentTime: 20 })
    assert.strictEqual(t.events.at(-1).name, 'Stop')
    assert.deepStrictEqual(t.sent.close, [{ playbackSessionId: 'ps1' }])
    assert.strictEqual(t.store.openSession.ps1, undefined)
    assert.strictEqual(t.saver.snapshot().sessionId, null)

    const e = setup({ net: UNMETERED })
    e.opened(book())
    await playing(e)
    e.native.positionSec = 15; e.tickAt(T0 + 15000); await e.idle()
    e.state({ reason: 'closed', sessionId: 'ps1', playing: false, positionSec: 20, error: true }, T0 + 20000); await e.idle()
    assert.strictEqual(e.sent.session.length, 1, 'no sync after an error')
    assert.deepStrictEqual(e.sent.close, [{ playbackSessionId: 'ps1' }])
  },

  async 'closing a local session does not close anything on the server (:1046)'() {
    const t = setup({ net: UNMETERED, native: { sessionId: 'ps-loc' } })
    t.opened(linked())
    await playing(t)
    t.state({ reason: 'closed', sessionId: 'ps-loc', playing: false, positionSec: 0, error: false }, T0 + 5000); await t.idle()
    assert.deepStrictEqual(t.sent.close, [])
  },

  async 'a player.getPosition that never answers skips that tick; the next tick counts the whole window (not Kotlin: the bridge has no timeout)'() {
    const t = setup({ net: UNMETERED, native: { silent: true }, timeoutMs: 5 })
    t.opened(book())
    await playing(t)
    t.tickAt(T0 + 15000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [])
    assert.ok(t.logs.some((l) => l.includes('timed out')))
    t.native.silent = false; t.native.positionSec = 30
    t.tickAt(T0 + 30000); await t.idle()
    assert.deepStrictEqual(t.sent.session[0].syncData, { timeListened: 30, duration: 100, currentTime: 30 })
  },

  async 'a tick while native says not playing does nothing (:81)'() {
    const t = setup({ net: UNMETERED, native: { playing: false, positionSec: 15 } })
    t.opened(book())
    await playing(t)
    t.tickAt(T0 + 15000); await t.idle()
    assert.deepStrictEqual(t.sent.session, [])
    assert.strictEqual((t.store.playbackSession || {}).ps1, undefined)
  },

  async 'legacy option reproduces the Kotlin over-count: timeListening 150 for 60 s of metered listening, where the server gets 60 (:238-239, :298-321)'() {
    const legacy = setup({ net: METERED, legacy: true })
    legacy.opened(book()); await playing(legacy)
    for (const s of [15, 30, 45, 60]) { legacy.native.positionSec = s; legacy.tickAt(T0 + s * 1000); await legacy.idle() }
    assert.strictEqual(legacy.lastSave().timeListening, 150)
    assert.strictEqual(legacy.sent.session[0].syncData.timeListened, 60, 'the server payload is right in Kotlin too')

    const correct = setup({ net: METERED })
    correct.opened(book()); await playing(correct)
    for (const s of [15, 30, 45, 60]) { correct.native.positionSec = s; correct.tickAt(T0 + s * 1000); await correct.idle() }
    assert.strictEqual(correct.lastSave().timeListening, 60)
    assert.strictEqual(correct.sent.session[0].syncData.timeListened, 60)
  },

  async 'the over-count reaches the server only through the saved row, when a later upload runs (sync.js local-all)'() {
    const legacy = setup({ net: METERED, legacy: true })
    legacy.opened(book()); await playing(legacy)
    legacy.ctl.serverError = 'Failed to connect'
    for (const s of [15, 30, 45, 60]) { legacy.native.positionSec = s; legacy.tickAt(T0 + s * 1000); await legacy.idle() }
    assert.strictEqual(legacy.store.playbackSession.ps1.timeListening, 150)
    const correct = setup({ net: METERED })
    correct.opened(book()); await playing(correct)
    correct.ctl.serverError = 'Failed to connect'
    for (const s of [15, 30, 45, 60]) { correct.native.positionSec = s; correct.tickAt(T0 + s * 1000); await correct.idle() }
    assert.strictEqual(correct.store.playbackSession.ps1.timeListening, 60)
  },

  async 'switch off (the default): the saver reads the switch and nothing else; playback events, ticks and the network are ignored'() {
    const t = setup({ coreSaver: false })
    await t.idle()
    assert.deepStrictEqual(t.calls.map((c) => c.connector + '.' + c.method), ['system.flags'], 'only the switch is read')
    t.opened(book())
    await playing(t)
    t.native.positionSec = 15
    t.tickAt(T0 + 15000)
    paused(t, 15, T0 + 15000)
    await t.idle()
    assert.strictEqual(t.schedules().length, 0, 'no tick is scheduled')
    assert.strictEqual(t.calls.filter((c) => c.connector === 'player').length, 0, 'native player is not asked')
    assert.deepStrictEqual([t.sent.session, t.sent.local, t.sent.close, t.events], [[], [], [], []], 'nothing is sent or written')
    assert.deepStrictEqual(t.store, {}, 'nothing is stored')
    assert.deepStrictEqual(t.alerts, [])
  },

  async 'a switch that cannot be read is off'() {
    const t = setup({ coreSaver: 'error' })
    await t.idle()
    t.opened(book())
    await playing(t)
    await t.idle()
    assert.strictEqual(t.schedules().length, 0)
    assert.strictEqual(t.saver.snapshot().sessionId, null, 'no session is taken while the switch is unknown')
    assert.ok(t.logs.some((m) => m.includes('switch could not be read')))
  },

  async 'switch on: start reads the network, and after a core restart the open session comes back from the core record and the window restarts while playing'() {
    const store = { openSession: { ps1: { session: book({ currentTime: 40, timeListening: 30 }), unsentSec: 7 } } }
    const t = setup({ store, native: { positionSec: 50, playing: true }, net: UNMETERED })
    await t.idle()
    assert.deepStrictEqual(t.calls.slice(0, 2).map((c) => c.connector + '.' + c.method), ['system.flags', 'system.network'])
    assert.deepStrictEqual(t.saver.snapshot(), { sessionId: 'ps1', running: true, unsentSec: 7, failedSyncs: 0 })
    assert.strictEqual(t.schedules().at(-1).atMs, T0 + TICK_MS, 'the 15 s tick is asked again')
  },

  async 'switch on: with no core record, the session JSON native sends is restored (paused: no window)'() {
    const t = setup({ native: { playing: false, session: book({ currentTime: 30 }) } })
    await t.idle()
    assert.deepStrictEqual(t.saver.snapshot(), { sessionId: 'ps1', running: false, unsentSec: 0, failedSyncs: 0 })
    assert.strictEqual(t.schedules().length, 0)
  },

  async 'switch on: with no live session native answers, nothing is taken'() {
    const t = setup({ native: { live: false, sessionId: null, playing: false } })
    await t.idle()
    assert.strictEqual(t.saver.snapshot().sessionId, null)
  }
}

let failed = 0
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('ok   ' + name) } catch (e) { failed++; console.log('FAIL ' + name + '\n' + e.stack) }
}
if (failed) process.exit(1)
