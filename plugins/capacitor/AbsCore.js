import { registerPlugin, WebPlugin } from '@capacitor/core'

/** iOS keeps its native logic for now (the core is Android only): every call fails and no event ever arrives. */
class AbsCoreWeb extends WebPlugin {
  async call() {
    throw new Error('The JS core is not available on this platform')
  }
}

export const AbsCore = registerPlugin('AbsCore', { web: () => new AbsCoreWeb() })

/**
 * The UI is a client of the core. `callCore(method, args)` asks a method the core serves and resolves with its answer;
 * `onCore(handler)` receives the events the core sends to the UI: handler(event, data). Returns a function that unsubscribes.
 */
export async function callCore(method, args = {}, timeoutMs = 10000) {
  const { result } = await AbsCore.call({ method, args, timeoutMs })
  return result
}

export async function onCore(handler) {
  const listener = await AbsCore.addListener('core', ({ event, data }) => handler(event, data))
  return () => listener.remove()
}

