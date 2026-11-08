import Foundation
import JavaScriptCore

/// One native connector: calls the iOS API and turns the result into JSON. No app logic (the same rule as Android's Connector.kt).
/// `reply` may be called from any thread, once.
protocol CoreConnector: AnyObject {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void)
}

/// The JS core in JavaScriptCore (iOS counterpart of android/.../core/CoreHost.kt). It loads public/core-ios/bundle.js (built from
/// utils/core by `npm run build:core-ios`), the same bridge protocol as Android: `NativeCore.call/answerUp/ready` down,
/// `__core.reply/event/callUp` up. All JSContext work runs on `queue`; connector replies are hopped back onto it.
/// Events and calls up that arrive before the core says it is ready are queued and replayed in order.
final class CoreHost {
    static let shared = CoreHost()

    private let queue = DispatchQueue(label: "abs.core.js")
    private var context: JSContext?
    private var ready = false
    private var queued: [() -> Void] = []
    private var connectors: [String: CoreConnector] = [:]
    private var nextUpId = 1
    private var waitingUp: [Int: (Bool, String) -> Void] = [:]
    private var timers: [Int: DispatchWorkItem] = [:]
    private var nextTimerId = 1
    private var startedAt = Date()
    private var started = false

    private init() {}

    func register(_ name: String, _ connector: CoreConnector) {
        queue.async { self.connectors[name] = connector }
    }

    /// Loads the core once. Safe to call again.
    func start() {
        queue.async {
            if self.started { return }
            self.started = true
            self.create()
        }
    }

    /// Native -> JS event. Safe from any thread. The time is taken now, not at delivery.
    func emit(_ connector: String, _ event: String, _ data: [String: Any] = [:]) {
        let t = Int(Date().timeIntervalSince1970 * 1000)
        let json = CoreHost.json(data)
        queue.async {
            self.whenReady { self.invoke("__core", "event", [connector, event, json, t]) }
        }
    }

    /// Native asks JS and waits, with a timeout. `callback` runs on the core queue: ok=false with a message on timeout or error.
    func callUp(_ connector: String, _ method: String, _ args: [String: Any] = [:], timeoutMs: Int = 5000,
                callback: @escaping (Bool, String) -> Void) {
        let json = CoreHost.json(args)
        queue.async {
            let id = self.nextUpId
            self.nextUpId += 1
            self.waitingUp[id] = callback
            self.queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
                if let cb = self.waitingUp.removeValue(forKey: id) { cb(false, "timeout") }
            }
            self.whenReady {
                if self.waitingUp[id] == nil { return } // timed out while queued
                self.invoke("__core", "callUp", [id, connector, method, json])
            }
        }
    }

    // MARK: - JSContext

    private func create() {
        startedAt = Date()
        ready = false
        guard let ctx = JSContext() else {
            NSLog("[core] no JSContext")
            return
        }
        context = ctx
        ctx.exceptionHandler = { _, value in
            NSLog("[core] exception: %@", value?.toString() ?? "?")
        }

        // Globals JavaScriptCore does not have: window, console, timers, btoa (the core uses them; no DOM)
        let nativeLog: @convention(block) (String) -> Void = { text in NSLog("[core] %@", text) }
        ctx.setObject(nativeLog, forKeyedSubscript: "__nlog" as NSString)
        let setTimer: @convention(block) (JSValue, Double, Bool) -> Int = { [weak self] fn, ms, repeats in
            self?.schedule(fn, ms, repeats) ?? 0
        }
        ctx.setObject(setTimer, forKeyedSubscript: "__setTimer" as NSString)
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.cancelTimer(id) }
        ctx.setObject(clearTimer, forKeyedSubscript: "__clearTimer" as NSString)
        let btoa: @convention(block) (String) -> String = { text in
            let bytes = text.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }
            return Data(bytes).base64EncodedString()
        }
        ctx.setObject(btoa, forKeyedSubscript: "btoa" as NSString)
        ctx.evaluateScript("""
            var window = this;
            var console = {
              log: function () { __nlog(Array.prototype.join.call(arguments, ' ')); },
              warn: function () { __nlog('WARN ' + Array.prototype.join.call(arguments, ' ')); },
              error: function () { __nlog('ERROR ' + Array.prototype.join.call(arguments, ' ')); }
            };
            var setTimeout = function (fn, ms) { return __setTimer(fn, ms || 0, false); };
            var setInterval = function (fn, ms) { return __setTimer(fn, ms || 0, true); };
            var clearTimeout = function (id) { __clearTimer(id); };
            var clearInterval = clearTimeout;
            """)

        // window.NativeCore: the native side of the bridge (bridge.js transport)
        let call: @convention(block) (String, String, String, Int) -> Void = { [weak self] connector, method, args, id in
            self?.callDown(connector, method, args, id)
        }
        let answerUp: @convention(block) (Int, Bool, String) -> Void = { [weak self] id, ok, json in
            self?.answeredUp(id, ok, json)
        }
        let readyBlock: @convention(block) () -> Void = { [weak self] in self?.coreReady() }
        let native = JSValue(newObjectIn: ctx)!
        native.setObject(call, forKeyedSubscript: "call" as NSString)
        native.setObject(answerUp, forKeyedSubscript: "answerUp" as NSString)
        native.setObject(readyBlock, forKeyedSubscript: "ready" as NSString)
        ctx.setObject(native, forKeyedSubscript: "NativeCore" as NSString)

        guard let url = Bundle.main.url(forResource: "bundle", withExtension: "js", subdirectory: "public/core-ios"),
              let source = try? String(contentsOf: url, encoding: .utf8) else {
            NSLog("[core] bundle.js missing from the app bundle (run npm run build:core-ios and cap sync)")
            return
        }
        ctx.evaluateScript(source, withSourceURL: url)
        NSLog("[core] bundle loaded (%d bytes)", source.utf8.count)
    }

    private func coreReady() {
        // Runs on the queue (called from JS while evaluating on it)
        ready = true
        NSLog("[core] READY after %d ms, replaying %d queued", Int(Date().timeIntervalSince(startedAt) * 1000), queued.count)
        let work = queued
        queued = []
        work.forEach { $0() }
    }

    private func whenReady(_ work: @escaping () -> Void) {
        if ready { work() } else { queued.append(work) }
    }

    private func callDown(_ connector: String, _ method: String, _ args: String, _ id: Int) {
        guard let c = connectors[connector] else {
            reply(id, false, "no connector \(connector)")
            return
        }
        let dict = CoreHost.parse(args)
        c.call(method, dict) { [weak self] ok, json in
            self?.queue.async { self?.reply(id, ok, json) }
        }
    }

    private func reply(_ id: Int, _ ok: Bool, _ json: String) {
        invoke("__core", "reply", [id, ok, json])
    }

    private func answeredUp(_ id: Int, _ ok: Bool, _ json: String) {
        queue.async {
            if let cb = self.waitingUp.removeValue(forKey: id) { cb(ok, json) }
        }
    }

    /// Calls window.<object>.<method>(args) on the context. Must run on the queue.
    private func invoke(_ object: String, _ method: String, _ args: [Any]) {
        guard let ctx = context, let target = ctx.objectForKeyedSubscript(object) else { return }
        target.invokeMethod(method, withArguments: args)
    }

    private func schedule(_ fn: JSValue, _ ms: Double, _ repeats: Bool) -> Int {
        // Runs on the queue (JS calls it there)
        let id = nextTimerId
        nextTimerId += 1
        scheduleOne(id, fn, ms, repeats)
        return id
    }

    private func scheduleOne(_ id: Int, _ fn: JSValue, _ ms: Double, _ repeats: Bool) {
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.timers[id] = nil
            fn.call(withArguments: [])
            if repeats { self.scheduleOne(id, fn, ms, repeats) }
        }
        timers[id] = item
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(max(0, ms))), execute: item)
    }

    private func cancelTimer(_ id: Int) {
        timers.removeValue(forKey: id)?.cancel()
    }

    // MARK: - JSON

    static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    static func parse(_ text: String) -> [String: Any] {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any] else { return [:] }
        return dict
    }
}
