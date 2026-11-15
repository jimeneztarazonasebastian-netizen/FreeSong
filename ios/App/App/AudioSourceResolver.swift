import Foundation

struct AudioTrack {
    let id: String
    let title: String
    let artist: String
    let artwork: String
    let duration: Double

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, !id.isEmpty else { return nil }
        self.id = id
        title = value["title"] as? String ?? "Sin título"
        artist = value["artist"] as? String ?? "FreeSong"
        artwork = value["thumbnail"] as? String ?? ""
        duration = (value["durationSeconds"] as? NSNumber)?.doubleValue
            ?? (value["duration"] as? NSNumber)?.doubleValue ?? 0
    }
}

struct AudioSource {
    let url: URL
    let videoId: String
    let origin: String
    let expires: Date
}

// Resolución, formato y caducidad son independientes del reproductor. Las
// peticiones salen del dispositivo que consumirá el audio, sin CORS del WKWebView.
actor AudioSourceResolver {
    static let backend = URL(string: "https://freesong-pied.vercel.app")!
    private let session: URLSession
    private var cache: [String: AudioSource] = [:]
    private var relays = [URL(string: "https://yt.chocolatemoo53.com")!]
    private var loadedRelays = false

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 12
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
    }

    func invalidate(_ id: String) { cache.removeValue(forKey: id) }

    func resolve(_ track: AudioTrack, quality: String) async throws -> AudioSource {
        try Task.checkCancellation()
        let key = "\(track.id):\(quality)"
        if let source = cache[key], source.expires > Date() { return source }
        if !loadedRelays {
            loadedRelays = true
            if let value = try? await json(Self.backend.appendingPathComponent("api/relay-info")),
               let instances = value["instances"] as? [String] {
                let allowed = instances.compactMap(URL.init(string:)).filter { $0.scheme == "https" && $0.host != nil }
                if !allowed.isEmpty { relays = Array(allowed.prefix(3)) }
            }
        }
        for base in relays {
            try Task.checkCancellation()
            if let source = await candidate(track.id, base: base, track: track, quality: quality) {
                cache[key] = source
                return source
            }
            // La copia oficial de la misma grabación; no el primer resultado
            // arbitrario. El vídeo original puede fallar aunque su búsqueda exista.
            var url = URLComponents(url: base.appendingPathComponent("api/v1/search"), resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "q", value: "\(track.title) \(track.artist)"), URLQueryItem(name: "type", value: "video")]
            if let list = try? await array(url.url!) {
                let candidates = list.filter { item in
                    guard let id = item["videoId"] as? String, id != track.id else { return false }
                    return sameRecording(item, track: track)
                }.sorted { left, right in
                    let a = (left["lengthSeconds"] as? NSNumber)?.doubleValue ?? 0
                    let b = (right["lengthSeconds"] as? NSNumber)?.doubleValue ?? 0
                    return abs(a - track.duration) < abs(b - track.duration)
                }
                for item in candidates.prefix(3) {
                    try Task.checkCancellation()
                    if let id = item["videoId"] as? String,
                       let source = await candidate(id, base: base, track: track, quality: quality) {
                        cache[key] = source
                        return source
                    }
                }
            }
        }
        var proxy = URLComponents(url: Self.backend.appendingPathComponent("api/stream"), resolvingAgainstBaseURL: false)!
        proxy.queryItems = [URLQueryItem(name: "id", value: track.id), URLQueryItem(name: "itag", value: quality),
                            URLQueryItem(name: "title", value: track.title), URLQueryItem(name: "artist", value: track.artist),
                            URLQueryItem(name: "dur", value: String(Int(track.duration)))]
        if await playable(proxy.url!) {
            let source = AudioSource(url: proxy.url!, videoId: track.id, origin: "proxy", expires: Date().addingTimeInterval(120))
            cache[key] = source
            return source
        }
        throw NSError(domain: "FreeSong.Source", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Las fuentes no entregaron audio reproducible. Prueba otra canción o reintenta."])
    }

    private func candidate(_ id: String, base: URL, track: AudioTrack, quality: String) async -> AudioSource? {
        var endpoint = URLComponents(url: base.appendingPathComponent("api/v1/videos/\(id)"), resolvingAgainstBaseURL: false)!
        endpoint.queryItems = [URLQueryItem(name: "local", value: "true")]
        guard let data = try? await json(endpoint.url!), data["error"] == nil else { return nil }
        let seconds = (data["lengthSeconds"] as? NSNumber)?.doubleValue ?? 0
        if seconds > 0 && track.duration > 0 && abs(seconds - track.duration) > max(12, track.duration * 0.07) { return nil }
        let formats = (data["adaptiveFormats"] as? [[String: Any]] ?? []).filter { format in
            let itag = String(describing: format["itag"] ?? "")
            return ["139", "140", "141"].contains(itag)
        }.sorted { left, right in
            String(describing: left["itag"] ?? "") == quality && String(describing: right["itag"] ?? "") != quality
        }
        for format in formats {
            guard let raw = format["url"] as? String, let url = URL(string: raw), url.scheme == "https",
                  !url.path.contains("/companion/"), await playable(url) else { continue }
            return AudioSource(url: url, videoId: id, origin: "relay", expires: Date().addingTimeInterval(15 * 60))
        }
        return nil
    }

    private func playable(_ url: URL) async -> Bool {
        do {
            try Task.checkCancellation()
            var request = URLRequest(url: url)
            request.setValue("bytes=0-1023", forHTTPHeaderField: "Range")
            let (bytes, response) = try await session.bytes(for: request)
            defer { bytes.task.cancel() }
            guard let response = response as? HTTPURLResponse, [200, 206].contains(response.statusCode) else { return false }
            let type = (response.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
            guard type.hasPrefix("audio/") || type.hasPrefix("video/mp4") || type.hasPrefix("application/octet-stream") else { return false }
            var iterator = bytes.makeAsyncIterator()
            return try await iterator.next() != nil
        } catch { return false }
    }

    private func json(_ url: URL) async throws -> [String: Any] {
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.badServerResponse) }
        return value
    }
    private func array(_ url: URL) async throws -> [[String: Any]] {
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let value = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw URLError(.badServerResponse) }
        return value
    }

    private func normalized(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "es"))
            .replacingOccurrences(of: "[^a-z0-9]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
    private func core(_ value: String) -> String {
        normalized(value.replacingOccurrences(of: "\\([^)]*\\)|\\[[^]]*\\]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\b(official|audio|video|hd|hq|4k|visualizer)\\b", with: " ", options: [.regularExpression, .caseInsensitive]))
    }
    private func sameRecording(_ item: [String: Any], track: AudioTrack) -> Bool {
        let title = item["title"] as? String ?? ""
        if title.range(of: "\\b(remix|cover|live|karaoke|instrumental|slowed|sped|reverb)\\b", options: [.regularExpression, .caseInsensitive]) != nil { return false }
        let t = core(track.title), artist = normalized(track.artist), candidate = core(title)
        guard [t, "\(artist) \(t)", "\(t) \(artist)"].contains(candidate) else { return false }
        let author = normalized(item["author"] as? String ?? "")
        guard !artist.isEmpty && (author.contains(artist) || candidate.contains(artist)) else { return false }
        let seconds = (item["lengthSeconds"] as? NSNumber)?.doubleValue ?? 0
        return track.duration <= 0 || (seconds > 0 && abs(seconds - track.duration) <= 12)
    }
}
