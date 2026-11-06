/** Diagnostics served to native and the debug receiver (Phase 0 measurements, kept for later checks on the Pixel). */
export function diagnosticsModule(bridge, { log = console.log, now = () => Date.now(), tick } = {}) {
  /**
   * tickTest({everyMs, ticks}): two quick start/stop cycles of a timer that would fire every second (none may fire), then a
   * timer of everyMs that stops after `ticks` ticks, then a wait for stray ticks. Logs lines starting with TICK.
   */
  bridge.serve('core', 'tickTest', async ({ everyMs = 15000, ticks = 2 } = {}) => {
    const start = now()
    const stray = []
    for (let c = 0; c < 2; c++) {
      const id = 'stray' + c
      await tick.start(id, { everyMs: 1000, onTick: () => stray.push(id) })
      await tick.stop(id)
    }
    log(`TICK cycles done at ${now() - start} ms`)
    let n = 0
    await tick.start('test', {
      everyMs,
      onTick: ({ atMs, t }) => {
        n++
        log(`TICK fire n=${n} asked=${atMs} firedAt=${t} lateMs=${t - atMs} coreLagMs=${now() - t}`)
      }
    })
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (n >= ticks) { clearInterval(poll); resolve() }
      }, 100)
    })
    await tick.stop('test')
    await new Promise((resolve) => setTimeout(resolve, 2500))
    log(`TICK end strayFires=${stray.length} testFires=${n} running=${tick.isRunning('test')} elapsed=${now() - start} ms`)
  })

  /** Timers: a sleep timer, a 15 s sync, `wake` alarms and `player` position ticks. Logs lines starting with TIMER. */
  bridge.serve('core', 'timerTest', ({ sleepMs = 60000, syncMs = 15000, wakeMs = 15000, durationMs = 300000 } = {}) => {
    const start = now()
    log(`TIMER start t=${start} sleepMs=${sleepMs} syncMs=${syncMs} wakeMs=${wakeMs} durationMs=${durationMs}`)
    setTimeout(() => log(`TIMER sleep expected=${sleepMs} actual=${now() - start} lateness=${now() - start - sleepMs}`), sleepMs)
    let syncs = 0
    const syncTimer = setInterval(() => {
      syncs++
      log(`TIMER sync n=${syncs} drift=${now() - start - syncs * syncMs}`)
    }, syncMs)
    let wakes = 0
    const scheduleWake = () => {
      wakes++
      bridge.call('wake', 'schedule', { id: 'w' + wakes, atMs: now() + wakeMs }).catch((e) => log('TIMER wake schedule failed ' + e.message))
    }
    const offWake = bridge.on('wake', 'wake', (data, t) => {
      log(`TIMER wake id=${data.id} exact=${data.exact} nativeLateness=${t - data.atMs} deliveryMs=${now() - t}`)
      scheduleWake()
    })
    scheduleWake()
    let ticks = 0, last = 0, maxGap = 0, maxLat = 0, sumLat = 0
    const offTicks = bridge.on('player', 'position', (data, t) => {
      if (last) maxGap = Math.max(maxGap, t - last)
      last = t
      const lat = now() - t
      maxLat = Math.max(maxLat, lat)
      sumLat += lat
      if (++ticks % 60 === 0) {
        log(`TIMER ticks n=${ticks} maxGapMs=${maxGap} avgDeliveryMs=${Math.round(sumLat / 60)} maxDeliveryMs=${maxLat}`)
        maxGap = maxLat = sumLat = 0
      }
    })
    setTimeout(() => {
      clearInterval(syncTimer)
      offWake()
      offTicks()
      log(`TIMER end elapsed=${now() - start} syncs=${syncs} wakes=${wakes} ticks=${ticks}`)
    }, durationMs)
  })

  /** Can the page reach the server by fetch (CORS), and through the `http` connector */
  bridge.serve('core', 'httpTest', async ({ url }) => {
    const show = (r) => `status=${r.status}`
    try { log('CORS fetch ping ' + show(await fetch(url + '/ping'))) } catch (e) { log('CORS fetch ping FAILED ' + e.message) }
    try { const r = await bridge.call('http', 'request', { method: 'GET', url: url + '/ping' }); log('CORS http connector ping status=' + r.status) } catch (e) { log('CORS http connector FAILED ' + e.message) }
  })
}
