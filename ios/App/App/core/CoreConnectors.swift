import Foundation
import Network
import Security
import UIKit

/// The iOS connectors for the JS core. Same names and shapes as android/.../core/*Connector.kt. Each one calls the iOS API and
/// returns the facts as JSON; none of them decides anything.

/// `http.request({method, url, headers, body, contentType, timeoutMs}) -> {status, headers, body}`
final class HttpConnector: CoreConnector {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        guard method == "request" else { return reply(false, "unknown http.\(method)") }
        guard let urlText = args["url"] as? String, let url = URL(string: urlText) else { return reply(false, "bad url") }
        var request = URLRequest(url: url)
        let verb = ((args["method"] as? String) ?? "GET").uppercased()
        request.httpMethod = verb
        request.timeoutInterval = TimeInterval(((args["timeoutMs"] as? NSNumber)?.doubleValue ?? 30000) / 1000)
        if let headers = args["headers"] as? [String: Any] {
            for (k, v) in headers { request.setValue("\(v)", forHTTPHeaderField: k) }
        }
        if let body = args["body"], !(body is NSNull) {
            if let text = body as? String {
                request.httpBody = text.data(using: .utf8)
            } else {
                request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed])
            }
            if request.value(forHTTPHeaderField: "Content-Type") == nil {
                request.setValue((args["contentType"] as? String) ?? "application/json", forHTTPHeaderField: "Content-Type")
            }
        } else if verb == "POST" || verb == "PUT" || verb == "PATCH" {
            request.httpBody = Data()
        }
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                return reply(false, error.localizedDescription)
            }
            guard let http = response as? HTTPURLResponse else { return reply(false, "no response") }
            var headers: [String: String] = [:]
            for (k, v) in http.allHeaderFields { headers["\(k)"] = "\(v)" }
            let text = String(data: data ?? Data(), encoding: .utf8) ?? ""
            reply(true, CoreHost.json(["status": http.statusCode, "headers": headers, "body": text]))
        }.resume()
    }
}

/// `store`: key-value, JSON strings in and out (get, put, putMany, delete, clear, list). One JSON file per collection in
/// Application Support/core-store, written on every change. Serial queue: the core may call from any thread.
final class StoreConnector: CoreConnector {
    private let queue = DispatchQueue(label: "abs.core.store")
    private var cache: [String: [String: String]] = [:]

    private func directory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("core-store", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func load(_ collection: String) -> [String: String] {
        if let c = cache[collection] { return c }
        let file = directory().appendingPathComponent("\(collection).json")
        let data = (try? Data(contentsOf: file)) ?? Data()
        let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] ?? [:]
        cache[collection] = dict
        return dict
    }

    /// Changes the cached collection in place and writes it to disk
    private func mutate(_ collection: String, _ change: (inout [String: String]) -> Void) {
        var c = load(collection)
        change(&c)
        cache[collection] = c
        save(collection)
    }

    private func save(_ collection: String) {
        let file = directory().appendingPathComponent("\(collection).json")
        if let data = try? JSONSerialization.data(withJSONObject: cache[collection] ?? [:]) {
            try? data.write(to: file, options: .atomic)
        }
    }

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        guard let collection = args["collection"] as? String else { return reply(false, "no collection") }
        queue.async {
            switch method {
            case "get":
                let key = args["key"] as? String ?? ""
                let value: Any = self.load(collection)[key] ?? NSNull()
                reply(true, CoreHost.json(["value": value]))
            case "put":
                let key = args["key"] as? String ?? ""
                self.mutate(collection) { $0[key] = args["value"] as? String ?? "" }
                reply(true, "")
            case "putMany":
                let items = (args["items"] as? [[String: Any]]) ?? []
                self.mutate(collection) { c in
                    for item in items { c[item["key"] as? String ?? ""] = item["value"] as? String ?? "" }
                }
                reply(true, "")
            case "delete":
                let key = args["key"] as? String ?? ""
                self.mutate(collection) { $0.removeValue(forKey: key) }
                reply(true, "")
            case "clear":
                self.cache[collection] = [:]
                self.save(collection)
                reply(true, "")
            case "list":
                let items = self.load(collection).map { ["key": $0.key, "value": $0.value] }
                reply(true, CoreHost.json(["items": items]))
            default:
                reply(false, "unknown store.\(method)")
            }
        }
    }
}

/// `secure`: the Keychain. get({key}) -> {value}, put({key, value}) -> {stored}, delete({key}) -> {removed}.
final class SecureConnector: CoreConnector {
    private let service = "com.selbereth.audiobookshelf.core"

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        let key = args["key"] as? String ?? ""
        switch method {
        case "get":
            var q = query(key)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: AnyObject?
            let status = SecItemCopyMatching(q as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data, let text = String(data: data, encoding: .utf8) {
                reply(true, CoreHost.json(["value": text]))
            } else if status == errSecItemNotFound {
                reply(true, CoreHost.json(["value": NSNull()]))
            } else {
                reply(false, "keychain get failed \(status)")
            }
        case "put":
            let value = (args["value"] as? String ?? "").data(using: .utf8) ?? Data()
            SecItemDelete(query(key) as CFDictionary)
            var q = query(key)
            q[kSecValueData as String] = value
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let status = SecItemAdd(q as CFDictionary, nil)
            reply(status == errSecSuccess, CoreHost.json(["stored": status == errSecSuccess]))
        case "delete":
            let status = SecItemDelete(query(key) as CFDictionary)
            reply(true, CoreHost.json(["removed": status == errSecSuccess]))
        default:
            reply(false, "unknown secure.\(method)")
        }
    }
}

/// `system.deviceInfo`, `system.appVersion`, `system.network`, `system.flags`: facts from iOS, nothing decided here.
/// Network changes go up as the event `system network` (the same as Android's watchNetwork).
final class SystemConnector: CoreConnector {
    private let monitor = NWPathMonitor()
    private var path: NWPath?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.path = path
            CoreHost.shared.emit("system", "network", SystemConnector.facts(path))
        }
        monitor.start(queue: DispatchQueue(label: "abs.core.network"))
    }

    static func facts(_ path: NWPath) -> [String: Any] {
        [
            "connected": path.status == .satisfied,
            "metered": path.isExpensive,
            "wifi": path.usesInterfaceType(.wifi),
            "validated": path.status == .satisfied
        ]
    }

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        let info = Bundle.main.infoDictionary ?? [:]
        switch method {
        case "deviceInfo":
            let device = UIDevice.current
            reply(true, CoreHost.json([
                "platform": "ios",
                "sdk": ProcessInfo.processInfo.operatingSystemVersionString,
                "manufacturer": "Apple",
                "model": device.model,
                "deviceId": device.identifierForVendor?.uuidString ?? "",
                "versionName": info["CFBundleShortVersionString"] as? String ?? ""
            ]))
        case "appVersion":
            reply(true, CoreHost.json([
                "versionName": info["CFBundleShortVersionString"] as? String ?? "",
                "versionCode": Int(info["CFBundleVersion"] as? String ?? "") ?? 0,
                "packageName": Bundle.main.bundleIdentifier ?? ""
            ]))
        case "network":
            let current = path ?? monitor.currentPath
            reply(true, CoreHost.json(SystemConnector.facts(current)))
        case "flags":
            reply(true, CoreHost.json(CoreSwitch.all()))
        default:
            reply(false, "unknown system.\(method)")
        }
    }
}

/// The core switches, read from UserDefaults (the iOS counterpart of CoreSwitch.kt). Default off. Keys `core.<name>`.
enum CoreSwitch {
    static let names = ["coreSaver", "coreSleep", "coreUi", "corePebble", "coreDownload"]

    static func isOn(_ name: String) -> Bool {
        UserDefaults.standard.bool(forKey: "core.\(name)")
    }

    static func all() -> [String: Bool] {
        Dictionary(uniqueKeysWithValues: names.map { ($0, isOn($0)) })
    }
}

/// `timer.schedule({id, atMs})` fires once at the wall-clock time the core names; `timer.cancel({id})` removes it. A tick goes up as
/// the event `timer tick {id, atMs}`. Same rule as TimerConnector.kt: scheduling an id again replaces the pending tick.
final class TimerConnector: CoreConnector {
    private let queue = DispatchQueue(label: "abs.core.timer")
    private var pending: [String: DispatchWorkItem] = [:]

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        let id = args["id"] as? String ?? ""
        switch method {
        case "schedule":
            let atMs = (args["atMs"] as? NSNumber)?.doubleValue ?? 0
            queue.async {
                self.pending.removeValue(forKey: id)?.cancel()
                let item = DispatchWorkItem { [weak self] in
                    self?.queue.async { self?.pending[id] = nil }
                    CoreHost.shared.emit("timer", "tick", ["id": id, "atMs": atMs])
                }
                self.pending[id] = item
                let delay = max(0, atMs - Date().timeIntervalSince1970 * 1000) / 1000
                self.queue.asyncAfter(deadline: .now() + delay, execute: item)
                reply(true, "")
            }
        case "cancel":
            queue.async {
                self.pending.removeValue(forKey: id)?.cancel()
                reply(true, "")
            }
        default:
            reply(false, "unknown timer.\(method)")
        }
    }
}

/// `ui.emit({event, data})`: hands an event to the visible web view. The AbsCore plugin on iOS is not written yet (Phase 12 slice 3),
/// so for now it is logged and reports delivered=false.
final class UiConnector: CoreConnector {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        guard method == "emit" else { return reply(false, "unknown ui.\(method)") }
        NSLog("[core] ui emit %@", (args["event"] as? String) ?? "?")
        reply(true, CoreHost.json(["delivered": false]))
    }
}

/// `files.exists({path}) -> {exists}`. content: URLs have no iOS counterpart yet and report false.
final class FilesConnector: CoreConnector {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        guard method == "exists" else { return reply(false, "unknown files.\(method)") }
        if let path = args["path"] as? String {
            reply(true, CoreHost.json(["exists": FileManager.default.fileExists(atPath: path)]))
        } else {
            reply(true, CoreHost.json(["exists": false]))
        }
    }
}

/// `device.sync(...)`: the transitional mirror of Android's DeviceManager. There is no native copy on iOS, so it only acknowledges.
final class DeviceConnector: CoreConnector {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        guard method == "sync" else { return reply(false, "unknown device.\(method)") }
        reply(true, "")
    }
}

/// `wake` (alarms) is not on iOS yet: it answers as a failure so the core knows.
final class UnsupportedConnector: CoreConnector {
    let name: String
    init(_ name: String) { self.name = name }
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        reply(false, "\(name).\(method) not on iOS yet")
    }
}

enum CoreConnectors {
    /// Registers every connector the iOS side has (the names match CoreHost.registerDefaults on Android).
    static func registerDefaults() {
        let host = CoreHost.shared
        host.register("http", HttpConnector())
        host.register("store", StoreConnector())
        host.register("secure", SecureConnector())
        host.register("system", SystemConnector())
        host.register("timer", TimerConnector())
        host.register("ui", UiConnector())
        host.register("files", FilesConnector())
        host.register("device", DeviceConnector())
        host.register("wake", UnsupportedConnector("wake"))
    }
}
