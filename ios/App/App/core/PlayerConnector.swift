import AVFoundation
import Foundation
import MediaPlayer

/// `player.*` on AVPlayer (iOS counterpart of android/.../core/PlayerConnector.kt). Facts and commands only: the core decides
/// what a change means (the saver, the sleep timer). Events up: `player state {reason, sessionId, playing, positionSec, rate, error}`
/// with reason playing, paused, seeked, ended, rate, closed; `session opened {session}`. All AVPlayer work is on the main queue.
/// Not on iOS yet: loadSession (server sessions), playItemPayload, jump (the app's jump amounts are a setting the core does not read).
final class PlayerConnector: CoreConnector {
    static let shared = PlayerConnector()

    private var player: AVPlayer?
    private var item: AVPlayerItem?
    private var sessionId: String?
    private var session: [String: Any]?
    private var title = ""
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var endObserver: NSObjectProtocol?
    private var lastPlaying = false

    private init() {
        configureRemoteCommands()
    }

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        DispatchQueue.main.async { self.dispatch(method, args, reply) }
    }

    private func dispatch(_ method: String, _ args: [String: Any], _ reply: @escaping (Bool, String) -> Void) {
        switch method {
        case "bind":
            reply(true, CoreHost.json(["live": true]))
        case "release":
            reply(true, "{}")
        case "getPosition":
            reply(true, CoreHost.json(snapshot(withSession: false)))
        case "getState":
            reply(true, CoreHost.json(snapshot(withSession: true)))
        case "loadLocal":
            loadLocal(args, reply)
        case "loadSession", "playItemPayload":
            reply(true, CoreHost.json(["ok": false, "reason": "failed"]))
            NSLog("[player] %@ not on iOS yet", method)
        case "play", "playService":
            command { $0.play() }
            reply(true, CoreHost.json(["live": player != nil]))
        case "pause", "pauseService":
            command { $0.pause() }
            reply(true, CoreHost.json(["live": player != nil]))
        case "playPause":
            command { p in if p.timeControlStatus == .playing { p.pause() } else { p.play() } }
            reply(true, CoreHost.json(["live": player != nil]))
        case "setVolume":
            player?.volume = Float((args["volume"] as? NSNumber)?.doubleValue ?? 1)
            reply(true, CoreHost.json(["live": player != nil]))
        case "seekBackward":
            let ms = (args["ms"] as? NSNumber)?.doubleValue ?? 0
            seek(toSeconds: max(0, currentSeconds() - ms / 1000), reason: "seeked")
            reply(true, CoreHost.json(["live": player != nil]))
        case "setSpeed":
            let speed = Float((args["speed"] as? NSNumber)?.doubleValue ?? 1)
            if let p = player {
                if p.timeControlStatus == .playing { p.rate = speed }
                emitState("rate")
            }
            reply(true, CoreHost.json(["live": player != nil]))
        default:
            reply(false, "unknown player.\(method)")
        }
    }

    private func command(_ action: (AVPlayer) -> Void) {
        guard let p = player else { return }
        action(p)
    }

    // MARK: - Loading

    private func loadLocal(_ args: [String: Any], _ reply: @escaping (Bool, String) -> Void) {
        guard let path = args["path"] as? String, FileManager.default.fileExists(atPath: path) else {
            return reply(true, CoreHost.json(["ok": false, "reason": "failed"]))
        }
        let rate = Float((args["playbackRate"] as? NSNumber)?.doubleValue ?? 1)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[player] audio session failed: %@", error.localizedDescription)
        }
        release()
        let newItem = AVPlayerItem(url: URL(fileURLWithPath: path))
        let p = AVPlayer(playerItem: newItem)
        player = p
        item = newItem
        sessionId = UUID().uuidString
        title = (path as NSString).lastPathComponent
        session = ["id": sessionId ?? "", "title": title, "path": path, "mediaType": "local"]
        observe(p, newItem)
        p.play()
        p.rate = rate
        NSLog("[player] loadLocal %@ rate=%.2f", title, rate)
        CoreHost.shared.emit("session", "opened", ["session": session ?? [:]])
        reply(true, CoreHost.json(["ok": true]))
    }

    private func observe(_ p: AVPlayer, _ i: AVPlayerItem) {
        statusObservation = p.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self = self, self.player === p else { return }
                let playing = p.timeControlStatus == .playing
                if playing != self.lastPlaying {
                    self.lastPlaying = playing
                    self.emitState(playing ? "playing" : "paused")
                }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: i, queue: .main) { [weak self] _ in
            self?.lastPlaying = false
            self?.emitState("ended")
        }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] _ in
            self?.updateNowPlaying()
        }
    }

    /// Stops and forgets the current player (its `closed` event is sent by the caller's choice, not here)
    private func release() {
        if let t = timeObserver { player?.removeTimeObserver(t) }
        timeObserver = nil
        statusObservation = nil
        if let e = endObserver { NotificationCenter.default.removeObserver(e) }
        endObserver = nil
        player?.pause()
        player = nil
        item = nil
    }

    // MARK: - Facts

    private func currentSeconds() -> Double {
        guard let p = player else { return 0 }
        let s = p.currentTime().seconds
        return s.isFinite ? s : 0
    }

    private func seek(toSeconds s: Double, reason: String) {
        guard let p = player else { return }
        p.seek(to: CMTime(seconds: s, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async { self?.emitState(reason) }
        }
    }

    private func noSession() -> [String: Any] {
        ["live": false, "playing": false, "positionSec": 0.0, "rate": 1.0, "sessionId": NSNull(), "session": NSNull(),
         "loaded": false, "idle": false, "lazyPlaying": false]
    }

    private func snapshot(withSession: Bool) -> [String: Any] {
        guard let p = player, let id = sessionId else { return noSession() }
        var o: [String: Any] = [
            "live": true,
            "playing": p.timeControlStatus == .playing,
            "positionSec": currentSeconds(),
            "rate": Double(p.rate),
            "sessionId": id,
            "atMs": Int(Date().timeIntervalSince1970 * 1000),
            "loaded": true,
            "idle": item == nil,
            "lazyPlaying": false
        ]
        if withSession { o["session"] = session ?? NSNull() }
        return o
    }

    /// Native fact at the moment of a change (the core decides what it means)
    private func emitState(_ reason: String, error: Bool = false) {
        guard let p = player else { return }
        let data: [String: Any] = [
            "reason": reason,
            "sessionId": sessionId ?? NSNull(),
            "playing": p.timeControlStatus == .playing,
            "positionSec": currentSeconds(),
            "rate": Double(p.rate),
            "error": error
        ]
        NSLog("[player] state %@ playing=%@ pos=%.2f", reason, p.timeControlStatus == .playing ? "true" : "false", currentSeconds())
        CoreHost.shared.emit("player", "state", data)
        updateNowPlaying()
    }

    // MARK: - Lock screen and Control Center (facts shown; the controls call the same commands above)

    private func updateNowPlaying() {
        guard let p = player else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentSeconds(),
            MPNowPlayingInfoPropertyPlaybackRate: Double(p.timeControlStatus == .playing ? p.rate : 0)
        ]
        if let d = item?.duration.seconds, d.isFinite { info[MPMediaItemPropertyPlaybackDuration] = d }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.command { $0.play() } }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.command { $0.pause() } }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async {
                self?.command { p in if p.timeControlStatus == .playing { p.pause() } else { p.play() } }
            }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            DispatchQueue.main.async { self?.seek(toSeconds: e.positionTime, reason: "seeked") }
            return .success
        }
    }
}

/// `sensor`: the shake. Register/unregister are the core's calls; the shake itself comes from MyViewController (motionEnded).
final class SensorConnector: CoreConnector {
    static let shared = SensorConnector()
    private var registered = false

    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        switch method {
        case "register":
            registered = true
            reply(true, CoreHost.json(["live": true]))
        case "unregister":
            registered = false
            reply(true, CoreHost.json(["live": true]))
        default:
            reply(false, "unknown sensor.\(method)")
        }
    }

    /// Called by the view controller when the device is shaken
    func shake() {
        guard registered else { return }
        CoreHost.shared.emit("sensor", "shake")
    }
}

/// `feedback`: haptics. vibrate({pattern: [wait, on, wait, on, ...]}) and chime({volume}). Approximations on iOS (the pattern is
/// played as taps at its times; the chime is a success haptic, volume is not applied).
final class FeedbackConnector: CoreConnector {
    func call(_ method: String, _ args: [String: Any], reply: @escaping (Bool, String) -> Void) {
        switch method {
        case "vibrate":
            let pattern = (args["pattern"] as? [NSNumber])?.map { $0.doubleValue } ?? []
            DispatchQueue.main.async {
                var at = 0.0
                for (i, ms) in pattern.enumerated() {
                    if i % 2 == 1 {
                        let start = at
                        DispatchQueue.main.asyncAfter(deadline: .now() + start / 1000) {
                            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                        }
                    }
                    at += ms
                }
            }
            reply(true, "")
        case "chime":
            DispatchQueue.main.async { UINotificationFeedbackGenerator().notificationOccurred(.success) }
            reply(true, "")
        default:
            reply(false, "unknown feedback.\(method)")
        }
    }
}
