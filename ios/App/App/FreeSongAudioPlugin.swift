import Capacitor
import AVFoundation
import MediaPlayer
import CryptoKit
import UIKit

private final class NativeDeck {
    let player = AVPlayer()
    var itemObservation: NSKeyValueObservation?
    var playbackObservation: NSKeyValueObservation?
    var endObserver: NSObjectProtocol?
    var timeObserver: Any?
    var index = -1
    var source: AudioSource?
    var pendingPosition: Double = 0
    var prerollReady = false
    var ready: Bool { player.currentItem?.status == .readyToPlay }
    func clear() {
        itemObservation = nil
        playbackObservation = nil
        if let observer = endObserver { NotificationCenter.default.removeObserver(observer) }
        endObserver = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        index = -1
        source = nil
        pendingPosition = 0
        prerollReady = false
    }
}

@objc(FreeSongAudioPlugin)
public final class FreeSongAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FreeSongAudioPlugin"
    public let jsName = "FreeSongAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importOffline", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeOffline", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearOffline", returnType: CAPPluginReturnPromise)
    ]
    private let resolver = AudioSourceResolver()
    private let decks = [NativeDeck(), NativeDeck()]
    private var active = 0
    private var tracks: [AudioTrack] = []
    private var requestId = ""
    private var operation = UUID()
    private var preloadOperation = UUID()
    private var loadingTask: Task<Void, Never>?
    private var preloadTask: Task<Void, Never>?
    private var deadline: DispatchWorkItem?
    private var wantsPlayback = false
    private var quality = "140"
    private var rate: Float = 1
    private var volume: Float = 0.88
    private var repeatMode = "all"
    private var shuffle = 0
    private var fadeSeconds: Double = 0
    private var fadeStart: TimeInterval?
    private var fadeLength: Double = 0
    private var fadeTimer: DispatchSourceTimer?
    private var sleepUntil: TimeInterval = 0
    private var sleepEndTrack = false
    private var artwork: MPMediaItemArtwork?
    private var artworkTask: URLSessionDataTask?
    private var artworkId = ""
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var notificationTokens: [NSObjectProtocol] = []
    private var lastError = ""
    private var resumeAfterInterruption = false
    private var lastProgressAt = ProcessInfo.processInfo.systemUptime
    private var previousTime: Double = 0
    private var transitioning = false
    private let offlineLock = NSLock()
    private let offlineIdsKey = "FreeSongAudio.offlineIds"
    private let offlineExtensionsKey = "FreeSongAudio.offlineExtensions"
    private var current: NativeDeck { decks[active] }
    private var upcoming: NativeDeck { decks[1 - active] }
    private var offlineDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("FreeSongAudio", isDirectory: true)
    }
    private func offlineURL(_ id: String, fileExtension requestedExtension: String? = nil) -> URL {
        let name = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        let extensions = UserDefaults.standard.dictionary(forKey: offlineExtensionsKey) as? [String: String] ?? [:]
        let suffix = requestedExtension ?? extensions[id] ?? "m4a"
        let allowed = ["m4a", "wav", "mp3", "aac", "webm"].contains(suffix) ? suffix : "m4a"
        return offlineDirectory.appendingPathComponent(name + "." + allowed)
    }

    public override func load() {
        DispatchQueue.main.async { [weak self] in self?.initialize() }
    }
    private func initialize() {
        for deck in decks {
            deck.player.automaticallyWaitsToMinimizeStalling = true
            deck.timeObserver = deck.player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self, weak deck] _ in
                guard let self = self, let deck = deck, deck === self.current else { return }
                self.tick()
            }
        }
        registerCommands()
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began {
                self.resumeAfterInterruption = self.wantsPlayback
                self.pauseInternal()
            } else {
                let rawOptions = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                if self.resumeAfterInterruption && AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume) { self.resumeInternal() }
                self.resumeAfterInterruption = false
            }
        })
        notificationTokens.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            if let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
               reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pauseInternal() }
        })
    }

    private func activateSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .default)
        try session.setActive(true)
    }
    private func applyOptions(_ call: CAPPluginCall) {
        if let value = call.getString("quality"), ["139", "140"].contains(value) { quality = value }
        if let value = call.getDouble("rate"), value.isFinite { rate = Float(min(3, max(0.5, value))) }
        if let value = call.getDouble("volume"), value.isFinite { volume = Float(min(1, max(0, value))) }
        if let value = call.getString("repeat"), ["all", "off", "one"].contains(value) { repeatMode = value }
        if let value = call.getInt("shuffle") { shuffle = value }
        if let enabled = call.getBool("crossfade") {
            fadeSeconds = enabled ? min(12, max(1, call.getDouble("crossfadeDuration") ?? 6)) : 0
        }
        if let value = call.getDouble("sleepUntil") { sleepUntil = value / 1000 }
        if let value = call.getBool("sleepEndTrack") { sleepEndTrack = value }
        if fadeStart == nil { current.player.volume = volume }
        if current.player.rate > 0 { current.player.rate = rate }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let values = call.getArray("queue", JSObject.self), values.count <= 2000 else { call.reject("Cola inválida"); return }
            let parsed = values.compactMap { AudioTrack($0) }
            let index = call.getInt("index") ?? 0
            guard parsed.count == values.count, parsed.indices.contains(index) else { call.reject("Pista inválida"); return }
            self.tracks = parsed
            self.requestId = call.getString("requestId") ?? UUID().uuidString
            self.applyOptions(call)
            self.begin(index, position: max(0, call.getDouble("position") ?? 0))
            call.resolve()
        }
    }
    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.pauseInternal(); call.resolve() }
    }
    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in self?.resumeInternal(); call.resolve() }
    }
    @objc func seek(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let position = call.getDouble("position"), position.isFinite else { call.reject("Posición inválida"); return }
            self.finishFade()
            let duration = self.duration(self.current)
            let target = max(0, duration > 0 ? min(position, max(0, duration - 0.05)) : position)
            self.current.pendingPosition = self.current.ready ? 0 : target
            let operation = self.operation
            self.current.player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self = self, self.operation == operation else { return }
                    self.previousTime = self.time(self.current)
                    self.lastProgressAt = ProcessInfo.processInfo.systemUptime
                    self.emit()
                }
            }
            call.resolve()
        }
    }
    @objc func configure(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            let oldShuffle = self.shuffle, oldRepeat = self.repeatMode
            self.applyOptions(call)
            if call.getBool("refreshNext") == true { self.resetPreload() }
            if let values = call.getArray("queue", JSObject.self) {
                let parsed = values.compactMap { AudioTrack($0) }
                let currentId = self.tracks.indices.contains(self.current.index) ? self.tracks[self.current.index].id : ""
                if parsed.count == values.count && parsed.count <= 2000,
                   let index = parsed.firstIndex(where: { $0.id == currentId }) {
                    self.tracks = parsed
                    self.current.index = index
                    self.resetPreload()
                }
            }
            if oldShuffle != self.shuffle || oldRepeat != self.repeatMode { self.resetPreload() }
            if self.fadeSeconds == 0 { self.finishFade() }
            self.emit()
            call.resolve()
        }
    }
    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.resolve(); return }
            var value = self.state()
            value["queue"] = self.tracks.map { ["id": $0.id, "title": $0.title, "artist": $0.artist, "thumbnail": $0.artwork, "duration": $0.duration] as [String: Any] }
            value["appVersion"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            value["iOSVersion"] = UIDevice.current.systemVersion
            value["offlineIds"] = (UserDefaults.standard.stringArray(forKey: self.offlineIdsKey) ?? [])
                .filter { FileManager.default.fileExists(atPath: self.offlineURL($0).path) }
            call.resolve(value)
        }
    }
    @objc func importOffline(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let raw = call.getString("data"),
              raw.count <= 140_000_000, let data = Data(base64Encoded: raw), data.count > 44 else { call.reject("Audio local inválido"); return }
        do {
            offlineLock.lock()
            defer { offlineLock.unlock() }
            let mime = call.getString("mime") ?? "audio/mp4"
            let suffix: String
            if data.prefix(4) == Data("RIFF".utf8) || mime.contains("wav") { suffix = "wav" }
            else if mime.contains("mpeg") { suffix = "mp3" }
            else if mime.contains("aac") { suffix = "aac" }
            else if mime.contains("webm") { suffix = "webm" }
            else { suffix = "m4a" }
            let oldURL = offlineURL(id), newURL = offlineURL(id, fileExtension: suffix)
            try FileManager.default.createDirectory(at: offlineDirectory, withIntermediateDirectories: true)
            try data.write(to: newURL, options: .atomic)
            if oldURL != newURL && FileManager.default.fileExists(atPath: oldURL.path) { try? FileManager.default.removeItem(at: oldURL) }
            var extensions = UserDefaults.standard.dictionary(forKey: offlineExtensionsKey) as? [String: String] ?? [:]
            extensions[id] = suffix
            UserDefaults.standard.set(extensions, forKey: offlineExtensionsKey)
            var ids = UserDefaults.standard.stringArray(forKey: offlineIdsKey) ?? []
            if !ids.contains(id) { ids.append(id); UserDefaults.standard.set(ids, forKey: offlineIdsKey) }
            call.resolve()
        } catch { call.reject("No se pudo guardar el audio local") }
    }
    @objc func removeOffline(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { call.reject("Pista inválida"); return }
        do {
            offlineLock.lock()
            defer { offlineLock.unlock() }
            let url = offlineURL(id)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            let ids = (UserDefaults.standard.stringArray(forKey: offlineIdsKey) ?? []).filter { $0 != id }
            UserDefaults.standard.set(ids, forKey: offlineIdsKey)
            var extensions = UserDefaults.standard.dictionary(forKey: offlineExtensionsKey) as? [String: String] ?? [:]
            extensions.removeValue(forKey: id)
            UserDefaults.standard.set(extensions, forKey: offlineExtensionsKey)
            call.resolve()
        } catch { call.reject("No se pudo quitar el audio local") }
    }

    @objc func clearOffline(_ call: CAPPluginCall) {
        do {
            offlineLock.lock()
            defer { offlineLock.unlock() }
            if FileManager.default.fileExists(atPath: offlineDirectory.path) { try FileManager.default.removeItem(at: offlineDirectory) }
            UserDefaults.standard.set([], forKey: offlineIdsKey)
            UserDefaults.standard.removeObject(forKey: offlineExtensionsKey)
            call.resolve()
        } catch { call.reject("No se pudieron borrar las descargas nativas") }
    }

    private func begin(_ index: Int, position: Double = 0) {
        guard tracks.indices.contains(index) else { return }
        operation = UUID()
        let token = operation
        loadingTask?.cancel()
        cancelFade()
        resetPreload()
        current.clear()
        current.index = index
        current.pendingPosition = position
        wantsPlayback = true
        transitioning = false
        lastError = ""
        previousTime = 0
        lastProgressAt = ProcessInfo.processInfo.systemUptime
        deadline?.cancel()
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, self.operation == token, self.wantsPlayback, self.time(self.current) < 0.1 else { return }
            self.loadingTask?.cancel()
            self.fail("La canción no arrancó a tiempo. Reintenta o elige otra pista.")
        }
        deadline = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 35, execute: timeout)
        let track = tracks[index], q = quality
        loadArtwork(track)
        emit()
        loadingTask = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                try self.activateSession()
                let file = self.offlineURL(track.id)
                let source: AudioSource
                if FileManager.default.fileExists(atPath: file.path) {
                    source = AudioSource(url: file, videoId: track.id, origin: "offline", expires: .distantFuture)
                } else { source = try await self.resolver.resolve(track, quality: q) }
                guard self.operation == token, !Task.isCancelled else { return }
                self.install(source, in: self.current, index: index, position: self.current.pendingPosition, start: self.wantsPlayback)
            } catch {
                guard self.operation == token, !Task.isCancelled else { return }
                self.fail(error.localizedDescription)
            }
        }
    }

    private func install(_ source: AudioSource, in deck: NativeDeck, index: Int, position: Double, start: Bool) {
        let asset = AVURLAsset(url: source.url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 12
        deck.source = source
        deck.index = index
        deck.pendingPosition = position
        deck.prerollReady = false
        deck.player.volume = deck === current ? volume : 0
        deck.player.replaceCurrentItem(with: item)
        deck.itemObservation = item.observe(\.status, options: [.new, .initial]) { [weak self, weak deck] item, _ in
            DispatchQueue.main.async {
                guard let self = self, let deck = deck, deck.player.currentItem === item else { return }
                if item.status == .failed {
                    if deck === self.current {
                        self.fail("iOS no pudo abrir la fuente de audio (\(item.error.map { ($0 as NSError).code } ?? 0)).")
                    } else { deck.clear() }
                } else if item.status == .readyToPlay && deck === self.current {
                    let target = deck.pendingPosition
                    deck.pendingPosition = 0
                    if target > 0 && target < self.duration(deck) - 0.5 {
                        deck.player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                    }
                    if self.wantsPlayback { deck.player.playImmediately(atRate: self.rate) }
                    self.emit()
                } else if item.status == .readyToPlay {
                    deck.player.preroll(atRate: self.rate) { [weak deck] success in
                        DispatchQueue.main.async {
                            guard let deck = deck, deck.player.currentItem === item else { return }
                            deck.prerollReady = success
                        }
                    }
                }
            }
        }
        deck.playbackObservation = deck.player.observe(\.timeControlStatus, options: [.new]) { [weak self, weak deck] _, _ in
            DispatchQueue.main.async {
                guard let self = self, let deck = deck, deck === self.current else { return }
                self.emit()
            }
        }
        deck.endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self, weak deck] _ in
            guard let self = self, let deck = deck, deck === self.current, self.wantsPlayback else { return }
            self.ended()
        }
        if start { deck.player.playImmediately(atRate: rate) }
    }

    private func duration(_ deck: NativeDeck) -> Double {
        AudioPolicy.duration(actual: deck.player.currentItem?.duration.seconds ?? 0,
                             metadata: tracks.indices.contains(deck.index) ? tracks[deck.index].duration : 0)
    }
    private func time(_ deck: NativeDeck) -> Double {
        let value = deck.player.currentTime().seconds
        return value.isFinite ? max(0, value) : 0
    }
    private func nextIndex(manual: Bool = false) -> Int? {
        guard !tracks.isEmpty else { return nil }
        if repeatMode == "one" && !manual { return current.index }
        if shuffle > 0 && tracks.count > 1 {
            let choices = tracks.indices.filter { $0 != current.index }
            return choices.randomElement()
        }
        return AudioPolicy.nextIndex(current: current.index, count: tracks.count, repeatMode: repeatMode, manual: manual)
    }
    private func resetPreload() {
        preloadOperation = UUID()
        preloadTask?.cancel()
        preloadTask = nil
        // Terminar un fundido antes de invalidar el deck entrante.
        if fadeStart != nil { finishFade() }
        upcoming.clear()
    }
    private func prepareNext() {
        guard preloadTask == nil, fadeStart == nil, let index = nextIndex(), index != current.index,
              tracks.indices.contains(index), !sleepEndTrack else { return }
        let token = preloadOperation, track = tracks[index], q = quality
        preloadTask = Task { @MainActor [weak self] in
            guard let self = self else { return }
            do {
                let file = self.offlineURL(track.id)
                let source: AudioSource
                if FileManager.default.fileExists(atPath: file.path) {
                    source = AudioSource(url: file, videoId: track.id, origin: "offline", expires: .distantFuture)
                } else { source = try await self.resolver.resolve(track, quality: q) }
                guard token == self.preloadOperation, !Task.isCancelled else { return }
                self.install(source, in: self.upcoming, index: index, position: 0, start: false)
            } catch { /* La pista actual continúa; el siguiente intento ocurre al avanzar. */ }
        }
    }
    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime, position = time(current)
        if abs(position - previousTime) > 0.01 {
            previousTime = position
            lastProgressAt = now
            deadline?.cancel()
        }
        if sleepUntil > 0 && Date().timeIntervalSince1970 >= sleepUntil {
            sleepUntil = 0
            pauseInternal()
            return
        }
        if wantsPlayback && current.ready && position > 0.1 && now - lastProgressAt > 20 {
            fail("La conexión de audio se detuvo. Reintenta para renovar la fuente.")
            return
        }
        if wantsPlayback && position > 0.3 { prepareNext() }
        let remaining = duration(current) - position
        if fadeSeconds > 0 && wantsPlayback && !sleepEndTrack && repeatMode != "one" && fadeStart == nil,
           remaining > 0.3 && remaining <= fadeSeconds * Double(rate), upcoming.ready && upcoming.prerollReady {
            fadeLength = min(fadeSeconds, remaining / Double(rate))
            fadeStart = now
            upcoming.player.volume = 0
            upcoming.player.playImmediately(atRate: rate)
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now(), repeating: .milliseconds(40))
            timer.setEventHandler { [weak self] in self?.advanceFade() }
            fadeTimer = timer
            timer.resume()
        }
        emit()
    }
    private func advanceFade() {
        guard let start = fadeStart, wantsPlayback else { return }
        // No bajar el saliente si la entrada aún espera datos.
        guard upcoming.player.timeControlStatus == .playing else {
            if ProcessInfo.processInfo.systemUptime - start > 2 { cancelFade(); upcoming.player.pause() }
            return
        }
        let progress = min(1, max(0, (ProcessInfo.processInfo.systemUptime - start) / max(0.1, fadeLength)))
        let gains = AudioPolicy.fadeGains(progress: progress, volume: volume)
        current.player.volume = gains.outgoing
        upcoming.player.volume = gains.incoming
        if progress >= 1 { finishFade() }
    }
    private func cancelFade() {
        fadeTimer?.cancel()
        fadeTimer = nil
        fadeStart = nil
        current.player.volume = volume
    }
    private func finishFade() {
        guard fadeStart != nil, upcoming.ready else { cancelFade(); return }
        cancelFade()
        current.clear()
        active = 1 - active
        current.player.volume = volume
        preloadTask = nil
        preloadOperation = UUID()
        previousTime = time(current)
        lastProgressAt = ProcessInfo.processInfo.systemUptime
        if tracks.indices.contains(current.index) { loadArtwork(tracks[current.index]) }
        emit()
    }
    private func ended() {
        guard !transitioning else { return }
        if sleepEndTrack { sleepEndTrack = false; pauseInternal(); return }
        if fadeStart != nil && upcoming.ready { finishFade(); return }
        if repeatMode == "one" {
            current.player.seek(to: .zero)
            previousTime = 0
            lastProgressAt = ProcessInfo.processInfo.systemUptime
            current.player.playImmediately(atRate: rate)
            return
        }
        transitioning = true
        if upcoming.ready {
            current.clear()
            active = 1 - active
            current.player.volume = volume
            current.player.playImmediately(atRate: rate)
            preloadTask = nil
            preloadOperation = UUID()
            previousTime = 0
            lastProgressAt = ProcessInfo.processInfo.systemUptime
            transitioning = false
            loadArtwork(tracks[current.index])
            emit()
        } else if let index = nextIndex() { begin(index) }
        else { pauseInternal() }
    }
    private func pauseInternal() {
        wantsPlayback = false
        finishFade()
        decks.forEach { $0.player.pause() }
        emit()
    }
    private func resumeInternal() {
        guard tracks.indices.contains(current.index) else { return }
        if current.player.currentItem == nil || !lastError.isEmpty { begin(current.index, position: time(current)); return }
        do { try activateSession() } catch { fail("No se pudo activar el audio de iOS."); return }
        wantsPlayback = true
        previousTime = time(current)
        lastProgressAt = ProcessInfo.processInfo.systemUptime
        current.player.playImmediately(atRate: rate)
        emit()
    }
    private func fail(_ message: String) {
        lastError = message
        if tracks.indices.contains(current.index), current.source?.origin != "offline" {
            let id = tracks[current.index].id, q = quality
            Task { await resolver.invalidate(id, quality: q) }
        }
        deadline?.cancel()
        wantsPlayback = false
        cancelFade()
        decks.forEach { $0.player.pause() }
        emit()
    }
    private func state() -> JSObject {
        let playing = wantsPlayback && current.player.timeControlStatus == .playing
        return ["engine": "avplayer", "requestId": requestId, "index": current.index,
                "trackId": tracks.indices.contains(current.index) ? tracks[current.index].id : "",
                "position": max(time(current), current.pendingPosition), "duration": duration(current), "playing": playing,
                "paused": !wantsPlayback, "buffering": wantsPlayback && !playing,
                "crossfading": fadeStart != nil, "error": lastError,
                "source": current.source?.origin ?? "resolving", "sourceVideoId": current.source?.videoId ?? ""]
    }
    private func emit() {
        updateNowPlaying()
        notifyListeners("state", data: state())
    }
    private func updateNowPlaying() {
        guard tracks.indices.contains(current.index) else { return }
        let track = tracks[current.index]
        var info: [String: Any] = [MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist,
                                  MPMediaItemPropertyAlbumTitle: "FreeSong", MPMediaItemPropertyPlaybackDuration: duration(current),
                                  MPNowPlayingInfoPropertyElapsedPlaybackTime: time(current),
                                  MPNowPlayingInfoPropertyPlaybackRate: wantsPlayback && current.player.timeControlStatus == .playing ? current.player.rate : 0,
                                  MPNowPlayingInfoPropertyDefaultPlaybackRate: rate,
                                  MPNowPlayingInfoPropertyPlaybackQueueIndex: current.index,
                                  MPNowPlayingInfoPropertyPlaybackQueueCount: tracks.count,
                                  MPNowPlayingInfoPropertyExternalContentIdentifier: track.id,
                                  MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue]
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        let commands = MPRemoteCommandCenter.shared()
        commands.nextTrackCommand.isEnabled = nextIndexAvailable()
        commands.changePlaybackPositionCommand.isEnabled = current.ready && duration(current) > 0
    }
    private func nextIndexAvailable() -> Bool {
        tracks.count > 1 && (current.index + 1 < tracks.count || repeatMode != "off" || shuffle > 0)
    }
    private func loadArtwork(_ track: AudioTrack) {
        if artworkId == track.id { return }
        artworkTask?.cancel()
        artworkId = track.id
        artwork = nil
        guard let url = URL(string: track.artwork), url.scheme == "https" else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        artworkTask = URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data = data, data.count < 5_000_000, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self = self, self.artworkId == track.id else { return }
                self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.updateNowPlaying()
            }
        }
        artworkTask?.resume()
    }
    private func registerCommands() {
        let center = MPRemoteCommandCenter.shared()
        func bind(_ command: MPRemoteCommand, action: @escaping (MPRemoteCommandEvent) -> Void) {
            command.isEnabled = true
            let target = command.addTarget { event in
                DispatchQueue.main.async { action(event) }
                return .success
            }
            remoteTargets.append((command, target))
        }
        bind(center.playCommand) { [weak self] _ in self?.resumeInternal() }
        bind(center.pauseCommand) { [weak self] _ in self?.pauseInternal() }
        bind(center.togglePlayPauseCommand) { [weak self] _ in
            guard let self = self else { return }
            if self.wantsPlayback { self.pauseInternal() } else { self.resumeInternal() }
        }
        bind(center.nextTrackCommand) { [weak self] _ in
            guard let self = self, let index = self.nextIndex(manual: true) else { return }
            self.begin(index)
        }
        bind(center.previousTrackCommand) { [weak self] _ in
            guard let self = self, !self.tracks.isEmpty else { return }
            if self.time(self.current) > 3 { self.current.player.seek(to: .zero); self.emit() }
            else { self.begin((self.current.index - 1 + self.tracks.count) % self.tracks.count) }
        }
        bind(center.changePlaybackPositionCommand) { [weak self] event in
            guard let self = self, let event = event as? MPChangePlaybackPositionCommandEvent else { return }
            self.finishFade()
            self.current.player.seek(to: CMTime(seconds: max(0, min(event.positionTime, self.duration(self.current))), preferredTimescale: 600))
            self.previousTime = self.time(self.current)
            self.lastProgressAt = ProcessInfo.processInfo.systemUptime
            self.emit()
        }
    }

    deinit {
        loadingTask?.cancel()
        preloadTask?.cancel()
        deadline?.cancel()
        fadeTimer?.cancel()
        artworkTask?.cancel()
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
        remoteTargets.forEach { $0.0.removeTarget($0.1) }
        for deck in decks {
            if let observer = deck.timeObserver { deck.player.removeTimeObserver(observer) }
            deck.clear()
        }
    }
}
