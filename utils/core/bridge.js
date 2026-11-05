/**
 * The bridge between the JS core and native, one protocol for every connector.
 *
 * transport (supplied by entry.js in the web view, by a fake in tests):
 *   transport.call(connector, method, argsJson, id)   core -> native, answered through handleReply
 *   transport.answerUp(id, ok, json)                  core's answer to a call from native
 *   transport.ready()                                 the core is up, native may replay queued events
 *
 * Down:      call(connector, method, args) -> Promise<result>          JSON in and out
 * Up:        on(connector, event, handler)  handler(data, t)           t = ms epoch when it happened natively
 * Calls up:  serve(connector, method, fn)   native asks, JS answers (Android Auto browse, UI commands)
 */
export function createBridge(transport) {
  let nextId = 1
  const pending = new Map()
  const handlers = new Map()
  const servers = new Map()

  const parse = (json) => (json ? JSON.parse(json) : undefined)

  return {
    call(connector, method, args = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        try {
          transport.call(connector, method, JSON.stringify(args), id)
        } catch (e) {
          pending.delete(id)
          reject(e)
        }
      })
    },

    on(connector, event, handler) {
      const key = connector + '/' + event
      if (!handlers.has(key)) handlers.set(key, new Set())
      handlers.get(key).add(handler)
      return () => handlers.get(key).delete(handler)
    },

    serve(connector, method, fn) {
      servers.set(connector + '/' + method, fn)
    },

    ready() {
      transport.ready()
    },

    /** Native's answer to call() */
    handleReply(id, ok, json) {
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok) p.resolve(parse(json))
      else p.reject(new Error(json || 'native call failed'))
    },

    /** Native event, in the order native saw them */
    handleEvent(connector, event, json, t) {
      const data = parse(json) || {}
      for (const h of [...(handlers.get(connector + '/' + event) || [])]) {
        try {
          h(data, t)
        } catch (e) {
          console.error('handler for ' + connector + '/' + event + ' threw: ' + e.message)
        }
      }
    },

    /** Native asks, JS answers (native waits with a timeout) */
    async handleCallUp(id, connector, method, json) {
      const fn = servers.get(connector + '/' + method)
      if (!fn) return transport.answerUp(id, false, 'no server for ' + connector + '/' + method)
      try {
        const result = await fn(parse(json) || {})
        transport.answerUp(id, true, result === undefined ? '' : JSON.stringify(result))
      } catch (e) {
        transport.answerUp(id, false, e.message || 'failed')
      }
    }
  }
}
