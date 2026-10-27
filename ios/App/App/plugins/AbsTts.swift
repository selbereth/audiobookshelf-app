//
//  AbsTts.swift
//  Audiobookshelf
//
//  Native text-to-speech for EPUBs. Sentences are streamed in from JS and queued
//  here so playback continues with the screen locked.
//

import Foundation
import Capacitor
import AVFoundation
import MediaPlayer

private struct TtsSentence {
    let id: Int
    let text: String
    let cfi: String
    let spine: Int
    let paragraph: Int
}

@objc(AbsTts)
public class AbsTts: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public var identifier = "AbsTtsPlugin"
    public var jsName = "AbsTts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prependChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "skip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekToSentence", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPitch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVoices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adjustSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWindow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise)
    ]

    private let window = 12
    private let queue = DispatchQueue(label: "abs.tts")  // guards all state below

    private var synth: AVSpeechSynthesizer?
    private var store: [TtsSentence] = []
    // Where each sentence is in `store`, found without scanning it. Text added at the front moves every position
    // by the same amount, so positions are kept relative to `shift` instead of being rewritten.
    private var positions: [Int: Int] = [:]
    private var shift = 0
    /// Pause when reading reaches the section with this index (where the next chapter starts)
    private var sleepUntilSpine: Int?
    private var sleepTimer: Timer?
    private var sleepEndsAt: Date?
    private var cursor = 0
    private var nextToQueue = 0
    private var queuedIds = Set<Int>()
    private var streamId = 0
    private var lastSeq = -1
    private var streamDone = false
    private var wantPlaying = false
    private var playing = false
    private var needMoreSentFor = -2
    private var active = false

    private var rate: Float = 1.0
    private var pitch: Float = 1.0
    private var lang: String?
    private var voiceId: String?
    private var title = ""
    private var author = ""
    private var commandTargets: [(MPRemoteCommand, Any)] = []

    // MARK: - Plugin methods

    @objc func start(_ call: CAPPluginCall) {
        queue.sync {
            teardownLocked()
            streamId = call.getInt("streamId") ?? 0
            lang = call.getString("lang")
            voiceId = call.getString("voiceId")
            rate = Float(call.getDouble("rate") ?? 1.0)
            pitch = Float(call.getDouble("pitch") ?? 1.0)
            title = call.getString("title") ?? ""
            author = call.getString("author") ?? ""
            active = true
        }
        DispatchQueue.main.async {
            let s = AVSpeechSynthesizer()
            s.delegate = self
            s.usesApplicationAudioSession = true
            self.queue.sync { self.synth = s }
            self.registerRemoteCommands()
            self.updateNowPlaying()
            call.resolve()
        }
    }

    @objc func appendChunk(_ call: CAPPluginCall) {
        let sid = call.getInt("streamId") ?? 0
        let seq = call.getInt("seq") ?? 0
        let done = call.getBool("done") ?? false
        var list: [TtsSentence] = []
        for item in call.getArray("sentences", JSObject.self) ?? [] {
            guard let id = item["id"] as? Int, let text = item["text"] as? String, let cfi = item["cfi"] as? String else { continue }
            list.append(TtsSentence(id: id, text: text, cfi: cfi, spine: item["spine"] as? Int ?? 0, paragraph: item["paragraph"] as? Int ?? 0))
        }
        let startId = call.getInt("startId")
        var positioned: TtsSentence?
        queue.sync {
            guard sid == streamId, seq > lastSeq else { return }
            lastSeq = seq
            appendToStore(list)
            if done { streamDone = true }
            if let startId = startId, let idx = indexOfId(startId) {
                // The first chunk holds history before the start: begin at the sentence the listener was at
                cursor = idx
                flushLocked()
                // Nothing starts speaking while paused, so tell the UI where we are now
                if !wantPlaying { positioned = store[idx] }
            }
            if wantPlaying { refillLocked() }
        }
        if let s = positioned { emitSentence(s) }
        call.resolve()
    }

    /// Text from before what was sent first, so the listener can rewind to the start of the book
    @objc func prependChunk(_ call: CAPPluginCall) {
        let sid = call.getInt("streamId") ?? 0
        var list: [TtsSentence] = []
        for item in call.getArray("sentences", JSObject.self) ?? [] {
            guard let id = item["id"] as? Int, let text = item["text"] as? String, let cfi = item["cfi"] as? String else { continue }
            list.append(TtsSentence(id: id, text: text, cfi: cfi, spine: item["spine"] as? Int ?? 0, paragraph: item["paragraph"] as? Int ?? 0))
        }
        queue.sync {
            guard sid == streamId, !list.isEmpty else { return }
            prependToStore(list)
            cursor += list.count
            nextToQueue += list.count
        }
        call.resolve()
    }

    // MARK: - Sleep timer

    @objc func setSleepTimer(_ call: CAPPluginCall) {
        cancelSleepTimerInternal(notify: false)
        if call.getBool("endOfChapter") ?? false {
            // JS sends a very large number for "no later chapter": the end of the book
            var until: Int?
            if let n = call.getValue("untilSpine") as? NSNumber { until = Int(clamping: n.int64Value) }
            queue.sync { sleepUntilSpine = until ?? (cursor < store.count ? store[cursor].spine + 1 : nil) }
            notifyListeners("sleepTimer", data: ["remainingMs": 0, "running": queue.sync { sleepUntilSpine != nil }, "atChapterEnd": true])
        } else {
            let ms = Double(call.getInt("ms") ?? 0)
            startSleepTimer(ms: ms)
        }
        call.resolve()
    }

    @objc func adjustSleepTimer(_ call: CAPPluginCall) {
        guard let ends = sleepEndsAt else { return call.resolve() }
        let delta = Double(call.getInt("ms") ?? 0)
        startSleepTimer(ms: max(ends.timeIntervalSinceNow * 1000 + delta, 1000))
        call.resolve()
    }

    @objc func cancelSleepTimer(_ call: CAPPluginCall) {
        cancelSleepTimerInternal(notify: true)
        call.resolve()
    }

    private func startSleepTimer(ms: Double) {
        cancelSleepTimerInternal(notify: false)
        sleepEndsAt = Date().addingTimeInterval(ms / 1000)
        DispatchQueue.main.async {
            self.sleepTimer = Timer.scheduledTimer(withTimeInterval: ms / 1000, repeats: false) { [weak self] _ in
                self?.sleepEndsAt = nil
                self?.pausePlayback(reason: "sleep")
                self?.notifyListeners("sleepTimer", data: ["remainingMs": 0, "running": false, "atChapterEnd": false])
            }
        }
        notifyListeners("sleepTimer", data: ["remainingMs": ms, "running": true, "atChapterEnd": false])
    }

    private func cancelSleepTimerInternal(notify: Bool) {
        DispatchQueue.main.async { self.sleepTimer?.invalidate(); self.sleepTimer = nil }
        sleepEndsAt = nil
        queue.sync { sleepUntilSpine = nil }
        if notify { notifyListeners("sleepTimer", data: ["remainingMs": 0, "running": false, "atChapterEnd": false]) }
    }

    // MARK: - Sentence store (call with `queue` held)

    private func indexOfId(_ id: Int) -> Int? {
        guard let p = positions[id] else { return nil }
        return p + shift
    }

    private func appendToStore(_ sentences: [TtsSentence]) {
        for (i, s) in sentences.enumerated() { positions[s.id] = store.count + i - shift }
        store.append(contentsOf: sentences)
    }

    private func prependToStore(_ sentences: [TtsSentence]) {
        shift += sentences.count
        for (i, s) in sentences.enumerated() { positions[s.id] = i - shift }
        store.insert(contentsOf: sentences, at: 0)
    }

    private func clearStore() {
        store.removeAll()
        positions.removeAll()
        shift = 0
    }

    @objc func play(_ call: CAPPluginCall) {
        startPlayback()
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        pausePlayback(reason: nil)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.sync { teardownLocked() }
        DispatchQueue.main.async {
            self.unregisterRemoteCommands()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            call.resolve()
        }
    }

    @objc func skip(_ call: CAPPluginCall) {
        let by = call.getString("by") ?? "sentence"
        let count = call.getInt("count") ?? 1
        skip(by: by, count: count)
        call.resolve()
    }

    @objc func seekToSentence(_ call: CAPPluginCall) {
        let id = call.getInt("id") ?? -1
        var found = false
        var current: TtsSentence?
        queue.sync {
            if let idx = indexOfId(id) {
                cursor = idx
                flushLocked()
                if wantPlaying { refillLocked() }
                found = true
                current = store[idx]
            }
        }
        if let s = current { emitSentence(s) }
        call.resolve(["found": found])
    }

    @objc func reset(_ call: CAPPluginCall) {
        queue.sync {
            flushLocked()
            clearStore()
            cursor = 0
            nextToQueue = 0
            sleepUntilSpine = nil
            streamId = call.getInt("streamId") ?? 0
            lastSeq = -1
            streamDone = false
            needMoreSentFor = -2
        }
        call.resolve()
    }

    @objc func setRate(_ call: CAPPluginCall) {
        queue.sync {
            rate = Float(call.getDouble("rate") ?? 1.0)
            flushLocked()
            if wantPlaying { refillLocked() }
        }
        call.resolve()
    }

    @objc func setPitch(_ call: CAPPluginCall) {
        queue.sync {
            pitch = Float(call.getDouble("pitch") ?? 1.0)
            flushLocked()
            if wantPlaying { refillLocked() }
        }
        call.resolve()
    }

    @objc func setVoice(_ call: CAPPluginCall) {
        queue.sync {
            let v = call.getString("voiceId") ?? ""
            voiceId = v.isEmpty ? nil : v
            flushLocked()
            if wantPlaying { refillLocked() }
        }
        call.resolve()
    }

    @objc func getVoices(_ call: CAPPluginCall) {
        let base = call.getString("lang")?.split(separator: "-").first.map { String($0).lowercased() }
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { v in
            guard let base = base else { return true }
            return v.language.lowercased().hasPrefix(base)
        }.map { v -> [String: Any] in
            ["id": v.identifier, "name": v.name, "lang": v.language, "quality": v.quality.rawValue, "network": false]
        }
        call.resolve(["voices": voices])
    }

    /// The sentence being spoken with some before and after it: the text view of the player shows them
    @objc func getWindow(_ call: CAPPluginCall) {
        let before = call.getInt("before") ?? 1
        let after = call.getInt("after") ?? 30
        queue.sync {
            guard !store.isEmpty else { return call.resolve(["sentences": [], "currentId": NSNull()]) }
            let from = max(cursor - before, 0)
            let to = min(cursor + after + 1, store.count)
            let slice = from < to ? Array(store[from..<to]) : []
            call.resolve([
                "sentences": slice.map { ["id": $0.id, "text": $0.text, "paragraph": $0.paragraph] },
                "currentId": cursor < store.count ? store[cursor].id : NSNull()
            ])
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        queue.sync {
            let cur = cursor < store.count ? store[cursor] : nil
            call.resolve([
                "active": active,
                "playing": playing,
                "currentId": cur?.id as Any,
                "currentCfi": cur?.cfi as Any,
                "streamId": streamId,
                "lastSeq": lastSeq,
                "bufferedCount": max(store.count - cursor, 0)
            ])
        }
    }

    // MARK: - Playback

    private func startPlayback() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true)
        } catch {
            notifyListeners("error", data: ["code": "audio_session", "message": error.localizedDescription])
            return
        }
        observeAudioSession()
        queue.sync {
            wantPlaying = true
            playing = true
            flushLocked()
            refillLocked()
        }
        notifyListeners("state", data: ["playing": true])
        updateNowPlaying()
    }

    private func pausePlayback(reason: String?) {
        queue.sync {
            wantPlaying = false
            playing = false
            flushLocked()
        }
        var data: [String: Any] = ["playing": false]
        if let reason = reason { data["reason"] = reason }
        notifyListeners("state", data: data)
        updateNowPlaying()
    }

    private func skip(by: String, count: Int) {
        var current: TtsSentence?
        queue.sync {
            var target = cursor
            if by == "paragraph" {
                var idx = cursor
                if count > 0 {
                    for _ in 0..<count {
                        guard idx < store.count else { break }
                        let p = store[idx].paragraph
                        while idx < store.count && store[idx].paragraph == p { idx += 1 }
                    }
                } else {
                    for _ in 0..<(-count) {
                        guard idx < store.count else { break }
                        let p = store[idx].paragraph
                        if idx > 0 && store[idx - 1].paragraph == p {
                            while idx > 0 && store[idx - 1].paragraph == p { idx -= 1 }
                        } else if idx > 0 {
                            let prev = store[idx - 1].paragraph
                            while idx > 0 && store[idx - 1].paragraph == prev { idx -= 1 }
                        }
                    }
                }
                target = idx
            } else {
                target = cursor + count
            }
            cursor = min(max(target, 0), max(store.count - 1, 0))
            flushLocked()
            if wantPlaying { refillLocked() }
            if cursor < store.count { current = store[cursor] }
        }
        if let s = current { emitSentence(s) }
    }

    // MARK: - Feeder (call with `queue` held)

    private func utterance(for s: TtsSentence) -> AVSpeechUtterance {
        let u = AVSpeechUtterance(string: s.text)
        // AVSpeechUtteranceDefaultSpeechRate is ~0.5 and maps to normal speed
        let def = AVSpeechUtteranceDefaultSpeechRate
        u.rate = min(max(def * rate, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
        u.pitchMultiplier = min(max(pitch, 0.5), 2.0)
        if let id = voiceId, let v = AVSpeechSynthesisVoice(identifier: id) {
            u.voice = v
        } else if let lang = lang, !lang.isEmpty {
            u.voice = AVSpeechSynthesisVoice(language: lang)
        }
        return u
    }

    private func refillLocked() {
        guard let synth = synth else { return }
        while queuedIds.count < window && nextToQueue < store.count {
            let s = store[nextToQueue]
            nextToQueue += 1
            queuedIds.insert(s.id)
            let u = utterance(for: s)
            ids[ObjectIdentifier(u)] = s.id
            synth.speak(u)
        }
    }

    private var ids: [ObjectIdentifier: Int] = [:]

    private func flushLocked() {
        // Delegate callbacks for cancelled utterances must be ignored: clear ids first
        queuedIds.removeAll()
        ids.removeAll()
        nextToQueue = cursor
        synth?.stopSpeaking(at: .immediate)
    }

    private func teardownLocked() {
        wantPlaying = false
        playing = false
        active = false
        flushLocked()
        clearStore()
        sleepUntilSpine = nil
        cursor = 0
        nextToQueue = 0
        lastSeq = -1
        streamDone = false
        needMoreSentFor = -2
        synth?.delegate = nil
        synth = nil
    }

    private func emitSentence(_ s: TtsSentence) {
        notifyListeners("sentence", data: ["id": s.id, "cfi": s.cfi, "spine": s.spine])
        updateNowPlaying()
    }

    // MARK: - AVSpeechSynthesizerDelegate

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        var sentence: TtsSentence?
        queue.sync {
            guard let id = ids[ObjectIdentifier(utterance)], let idx = indexOfId(id) else { return }
            cursor = idx
            sentence = store[idx]
        }
        if let s = sentence { emitSentence(s) }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange, utterance: AVSpeechUtterance) {
        var id: Int?
        queue.sync { id = ids[ObjectIdentifier(utterance)] }
        if let id = id {
            notifyListeners("word", data: ["id": id, "start": characterRange.location, "end": characterRange.location + characterRange.length, "length": characterRange.length])
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        var ended = false
        var needMore = false
        var sleepNow = false
        var sid = 0
        var seq = 0
        queue.sync {
            guard let id = ids.removeValue(forKey: ObjectIdentifier(utterance)) else { return } // flushed
            queuedIds.remove(id)
            if let idx = indexOfId(id) { cursor = min(idx + 1, store.count) }
            if let until = sleepUntilSpine, cursor < store.count, store[cursor].spine >= until {
                // The next chapter starts: the cursor is on its first sentence so resuming continues there
                sleepUntilSpine = nil
                sleepNow = true
            }
            if wantPlaying && !sleepNow { refillLocked() }
            if queuedIds.isEmpty && nextToQueue >= store.count && streamDone {
                ended = true
                wantPlaying = false
                playing = false
            }
            if !streamDone && store.count - cursor < 100 && needMoreSentFor != lastSeq {
                needMoreSentFor = lastSeq
                needMore = true
                sid = streamId
                seq = lastSeq
            }
        }
        if sleepNow {
            pausePlayback(reason: "sleep")
            notifyListeners("sleepTimer", data: ["remainingMs": 0, "running": false, "atChapterEnd": false])
            return
        }
        if needMore { notifyListeners("needMore", data: ["streamId": sid, "lastSeq": seq]) }
        if ended {
            notifyListeners("ended", data: [:])
            updateNowPlaying()
        }
    }

    // MARK: - Lock screen, interruptions

    private var observing = false

    private func observeAudioSession() {
        if observing { return }
        observing = true
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
    }

    @objc private func handleInterruption(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            if playing { pausePlayback(reason: "focus") }
        } else if let optRaw = n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt, AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume) {
            if active { startPlayback() }
        }
    }

    @objc private func handleRouteChange(_ n: Notification) {
        guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt, let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        if reason == .oldDeviceUnavailable && playing { pausePlayback(reason: "noisy") }
    }

    private func registerRemoteCommands() {
        unregisterRemoteCommands()
        let cc = MPRemoteCommandCenter.shared()
        func add(_ cmd: MPRemoteCommand, _ handler: @escaping () -> Void) {
            cmd.isEnabled = true
            let t = cmd.addTarget { _ in handler(); return .success }
            commandTargets.append((cmd, t))
        }
        add(cc.playCommand) { [weak self] in self?.startPlayback() }
        add(cc.pauseCommand) { [weak self] in self?.pausePlayback(reason: nil) }
        add(cc.togglePlayPauseCommand) { [weak self] in
            guard let self = self else { return }
            if self.playing { self.pausePlayback(reason: nil) } else { self.startPlayback() }
        }
        add(cc.nextTrackCommand) { [weak self] in self?.skip(by: "sentence", count: 1) }
        add(cc.previousTrackCommand) { [weak self] in self?.skip(by: "sentence", count: -1) }
    }

    private func unregisterRemoteCommands() {
        for (cmd, target) in commandTargets { cmd.removeTarget(target) }
        commandTargets.removeAll()
    }

    private func updateNowPlaying() {
        var rateValue = 0.0
        queue.sync { rateValue = playing ? 1.0 : 0.0 }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: author,
            MPNowPlayingInfoPropertyPlaybackRate: rateValue
        ]
    }
}
