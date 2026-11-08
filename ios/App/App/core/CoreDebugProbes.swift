#if DEBUG
import Foundation
import WebKit

/// Simulator checks for the core on iOS (DEBUG builds only). Each probe logs `[core probe] ...` lines to the simulator log.
enum CoreDebugProbes {
    /// Launch probes: the core's ping and db call, Keychain and store values that must survive a relaunch, and a local file played
    /// through the player connector when Documents/test.m4a exists.
    static func runAtLaunch() {
        CoreHost.shared.callUp("core", "db.getDeviceData", timeoutMs: 5000) { ok, json in
            NSLog("[core probe] db.getDeviceData ok=%@ %@", ok ? "true" : "false", String(json.prefix(120)))
        }
        CoreHost.shared.callUp("core", "server.ping", ["address": "http://127.0.0.1:9"], timeoutMs: 8000) { ok, json in
            NSLog("[core probe] server.ping closed port ok=%@ %@", ok ? "true" : "false", json)
        }

        // Keychain: read the value a previous launch wrote; write one if there is none
        let secure = SecureConnector()
        secure.call("get", ["key": "probe.token"]) { ok, json in
            NSLog("[core probe] secure.get before ok=%@ %@", ok ? "true" : "false", json)
            if json.contains("null") {
                secure.call("put", ["key": "probe.token", "value": "kept-\(Int(Date().timeIntervalSince1970))"]) { ok, json in
                    NSLog("[core probe] secure.put ok=%@ %@", ok ? "true" : "false", json)
                }
            }
        }

        // Store: the same for a collection (one JSON file in Application Support)
        let store = StoreConnector()
        store.call("get", ["collection": "probe", "key": "n"]) { ok, json in
            NSLog("[core probe] store.get before ok=%@ %@", ok ? "true" : "false", json)
            if json.contains("null") {
                store.call("put", ["collection": "probe", "key": "n", "value": "first-\(Int(Date().timeIntervalSince1970))"]) { ok, json in
                    NSLog("[core probe] store.put ok=%@ %@", ok ? "true" : "false", json)
                }
            }
        }

        // Player: plays Documents/test.m4a (copied in by the test), reads the position, then pauses
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let file = docs.appendingPathComponent("test.m4a").path
        guard FileManager.default.fileExists(atPath: file) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            PlayerConnector.shared.call("loadLocal", ["path": file, "playbackRate": 1.0]) { ok, json in
                NSLog("[core probe] player.loadLocal ok=%@ %@", ok ? "true" : "false", json)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) {
            PlayerConnector.shared.call("getPosition", [:]) { ok, json in
                NSLog("[core probe] player.getPosition at 7 s ok=%@ %@", ok ? "true" : "false", json)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 9) {
            PlayerConnector.shared.call("pause", [:]) { _, _ in
                PlayerConnector.shared.call("getState", [:]) { ok, json in
                    NSLog("[core probe] player.getState after pause ok=%@ %@", ok ? "true" : "false", String(json.prefix(200)))
                }
            }
        }
    }

    /// The visible web view calls the core through the AbsCore plugin, subscribes to its events and asks for `hello`, which the core
    /// answers with a `ui` event. The result goes to the log.
    static func runWebView(_ webView: WKWebView?) {
        guard let webView = webView else { return }
        // A promise cannot be returned to evaluateJavaScript (iOS 15), so the page stores its result and a second call reads it
        let start = """
        window.__coreEvents = [];
        window.__probeResult = 'pending';
        (async () => {
          const core = window.Capacitor.Plugins.AbsCore;
          await core.addListener('core', (e) => window.__coreEvents.push(e));
          const device = await core.call({ method: 'db.getDeviceData', args: {} });
          await core.call({ method: 'hello', args: {} });
          await new Promise((r) => setTimeout(r, 800));
          window.__probeResult = JSON.stringify({ deviceKeys: Object.keys(device.result || {}), events: window.__coreEvents });
        })().catch((e) => { window.__probeResult = 'error ' + e.message; });
        'started'
        """
        webView.evaluateJavaScript(start) { _, error in
            if let error = error { NSLog("[core probe] web AbsCore start FAILED %@", error.localizedDescription) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            webView.evaluateJavaScript("window.__probeResult") { result, error in
                if let error = error {
                    NSLog("[core probe] web AbsCore read FAILED %@", error.localizedDescription)
                } else {
                    NSLog("[core probe] web AbsCore %@", String(describing: result ?? "nil").prefix(400).description)
                }
            }
        }
    }
}
#endif
