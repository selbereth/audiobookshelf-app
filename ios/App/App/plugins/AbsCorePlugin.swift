//
//  AbsCorePlugin.swift
//  Audiobookshelf
//
//  The visible web view's connection to the JS core (iOS counterpart of plugins/AbsCore.kt). `call` asks a `core` method and
//  resolves with its answer; events the core sends with `ui.emit` arrive as the plugin event `core` {event, data}. Native relays only.
//

import Foundation
import Capacitor

@objc(AbsCore)
public class AbsCorePlugin: CAPPlugin, CAPBridgedPlugin {
    public var identifier = "AbsCorePlugin"
    public var jsName = "AbsCore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise)
    ]

    private static weak var instance: AbsCorePlugin?

    override public func load() {
        AbsCorePlugin.instance = self
    }

    @objc func call(_ call: CAPPluginCall) {
        guard let method = call.getString("method") else { return call.reject("method missing") }
        let args = call.getObject("args") ?? [:]
        let timeoutMs = call.getInt("timeoutMs") ?? 10000
        CoreHost.shared.callUp("core", method, args, timeoutMs: timeoutMs) { ok, json in
            DispatchQueue.main.async {
                if ok {
                    let value: Any = json.isEmpty ? NSNull() : (CoreHost.parseAny(json) ?? NSNull())
                    call.resolve(["result": value])
                } else {
                    call.reject(json)
                }
            }
        }
    }

    /// True when the UI is open and got the event (the `ui` connector's answer, delivered)
    static func send(_ event: String, _ data: [String: Any]) -> Bool {
        guard let plugin = instance else { return false }
        DispatchQueue.main.async {
            plugin.notifyListeners("core", data: ["event": event, "data": data])
        }
        return true
    }
}
