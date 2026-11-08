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
        let store = StoreConnector.shared
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
        // Not while the server probe runs: a second load would replace its session
        let serverFlag = docs.appendingPathComponent("server-test.flag").path
        guard FileManager.default.fileExists(atPath: file), !FileManager.default.fileExists(atPath: serverFlag) else { return }
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
                    CoreHost.shared.callUp("core", "db.getAllLocalMediaProgress", timeoutMs: 5000) { ok, json in
                        NSLog("[core probe] db.getAllLocalMediaProgress ok=%@ %@", ok ? "true" : "false", String(json.prefix(300)))
                    }
                }
            }
        }
    }

    /// Server path (fake server on 127.0.0.1:8765): authorize, playItem through the core, loadSession, a forward jump, a pause.
    /// Runs when Documents/server-test.flag exists (the flag keeps the probe off in other launches).
    static func runServer() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        guard FileManager.default.fileExists(atPath: docs.appendingPathComponent("server-test.flag").path) else { return }
        let address = "http://127.0.0.1:8765"
        let token = "fake-token-123"
        SystemConnector().call("flags", [:]) { _, json in NSLog("[core probe] system.flags %@", json) }
        // Stands in for the app's login: a server connection config in the device data (the core's record)
        StoreConnector.shared.call("get", ["collection": "device", "key": "data"]) { _, json in
            var data = CoreHost.parse(CoreHost.parse(json)["value"] as? String ?? "")
            var configs = (data["serverConnectionConfigs"] as? [[String: Any]]) ?? []
            configs.removeAll { ($0["id"] as? String) == "cfg-fake" }
            configs.append(["id": "cfg-fake", "name": "fake server", "address": address, "token": token, "username": "test", "version": "fake"])
            data["serverConnectionConfigs"] = configs
            data["lastServerConnectionConfigId"] = "cfg-fake"
            StoreConnector.shared.call("put", ["collection": "device", "key": "data", "value": CoreHost.json(data)]) { ok, _ in
                NSLog("[core probe] fake server config saved ok=%@", ok ? "true" : "false")
            }
        }
        CoreHost.shared.callUp("core", "server.authorize", ["address": address, "token": token], timeoutMs: 8000) { ok, json in
            NSLog("[core probe] server.authorize ok=%@ %@", ok ? "true" : "false", String(json.prefix(160)))
            CoreHost.shared.callUp("core", "server.playItem", ["address": address, "token": token, "libraryItemId": "fakeitem1", "payload": PlayItemPayload.build()], timeoutMs: 15000) { ok, json in
                NSLog("[core probe] server.playItem ok=%@ %@", ok ? "true" : "false", String(json.prefix(200)))
                guard ok, let session = CoreHost.parse(json) as [String: Any]?, session["audioTracks"] != nil else { return }
                PlayerConnector.shared.call("loadSession", ["session": session, "playbackRate": 1.0, "token": token]) { ok, json in
                    NSLog("[core probe] player.loadSession ok=%@ %@", ok ? "true" : "false", json)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                    PlayerConnector.shared.call("jump", ["forward": true]) { ok, json in
                        NSLog("[core probe] player.jump forward ok=%@ %@", ok ? "true" : "false", json)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 14) {
                    SystemConnector().call("network", [:]) { _, json in NSLog("[core probe] system.network at 14 s %@", json) }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 35) {
                    CoreHost.shared.callUp("core", "db.getAllLocalMediaProgress", timeoutMs: 5000) { ok, json in
                        NSLog("[core probe] db.getAllLocalMediaProgress ok=%@ %@", ok ? "true" : "false", String(json.prefix(300)))
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                    PlayerConnector.shared.call("pause", [:]) { _, _ in
                        PlayerConnector.shared.call("getPosition", [:]) { ok, json in
                            NSLog("[core probe] player.getPosition after pause ok=%@ %@", ok ? "true" : "false", json)
                        }
                    }
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
