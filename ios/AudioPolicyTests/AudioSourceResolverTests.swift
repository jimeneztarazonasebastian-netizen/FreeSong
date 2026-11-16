import Foundation
import XCTest
@testable import FreeSongAudioPolicy

private final class SourceProtocol: URLProtocol {
    static let lock = NSLock()
    static var requests: [URLRequest] = []
    static var mode = "valid"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.requests.append(request)
        let mode = Self.mode
        Self.lock.unlock()
        let url = request.url!, path = url.path
        var status = 200, type = "application/json", body: Data
        if path == "/youtubei/v1/player" && mode == "native" {
            body = Data(#"{"playabilityStatus":{"status":"OK"},"videoDetails":{"lengthSeconds":"191"},"streamingData":{"adaptiveFormats":[{"itag":140,"url":"https://media.test/audio/device"}]}}"#.utf8)
        }
        else if path == "/api/relay-info" { body = Data(#"{"instances":["https://relay.test"]}"#.utf8) }
        else if path == "/api/v1/search" {
            body = Data(#"[{"videoId":"alias-2","title":"Artista - Uno [Official Audio]","author":"Sello","lengthSeconds":191},{"videoId":"remix","title":"Uno remix","author":"Artista","lengthSeconds":191}]"#.utf8)
        } else if path.hasPrefix("/api/v1/videos/") {
            let id = url.lastPathComponent
            let seconds = mode == "mismatch" && id == "original-1" ? 381 : 191
            body = Data("{\"lengthSeconds\":\(seconds),\"adaptiveFormats\":[{\"itag\":140,\"url\":\"https://relay.test/audio/\(id)\"}]}".utf8)
        } else if path.hasPrefix("/audio/") {
            if mode == "html" || mode == "proxy" || (mode == "native" && url.host != "media.test") || (mode == "retry" && url.lastPathComponent == "original-1") {
                type = "text/html"
                status = mode == "retry" ? 403 : 200
                body = Data("<html>not audio</html>".utf8)
            } else {
                type = "audio/mp4"
                status = 206
                body = Data([0, 0, 0, 24, 102, 116, 121, 112])
            }
        } else if path == "/api/stream" && mode == "proxy" {
            type = "audio/mp4"
            status = 206
            body = Data([0, 0, 0, 24, 102, 116, 121, 112])
        } else { status = 502; body = Data("{}".utf8) }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class AudioSourceResolverTests: XCTestCase {
    private let track = AudioTrack(["id": "original-1", "title": "Uno", "artist": "Artista", "duration": 191])!
    private func resolver(_ mode: String) -> AudioSourceResolver {
        SourceProtocol.lock.lock()
        SourceProtocol.mode = mode
        SourceProtocol.requests = []
        SourceProtocol.lock.unlock()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SourceProtocol.self]
        return AudioSourceResolver(session: URLSession(configuration: config))
    }
    private func requestCount() -> Int {
        SourceProtocol.lock.lock(); defer { SourceProtocol.lock.unlock() }
        return SourceProtocol.requests.count
    }
    func testValidAudioIsProbedAndCached() async throws {
        let resolver = resolver("valid")
        let source = try await resolver.resolve(track, quality: "140")
        XCTAssertEqual(source.videoId, track.id)
        let count = requestCount()
        _ = try await resolver.resolve(track, quality: "140")
        XCTAssertEqual(requestCount(), count)
        XCTAssertTrue(SourceProtocol.requests.contains { $0.value(forHTTPHeaderField: "Range") == "bytes=0-1023" })
        await resolver.invalidate(track.id, quality: "140")
        _ = try await resolver.resolve(track, quality: "140")
        XCTAssertGreaterThan(requestCount(), count, "Un fallo debe permitir renovar la URL")
    }
    func test403UsesADifferentRecordingAndNeverAcceptsRemix() async throws {
        let source = try await resolver("retry").resolve(track, quality: "140")
        XCTAssertEqual(source.videoId, "alias-2")
        XCTAssertFalse(SourceProtocol.requests.contains { $0.url?.lastPathComponent == "remix" })
    }
    func testDurationMismatchUsesMatchingAlternative() async throws {
        let source = try await resolver("mismatch").resolve(track, quality: "140")
        XCTAssertEqual(source.videoId, "alias-2")
    }
    func testHTMLWithSuccessStatusIsNotAudio() async throws {
        do {
            _ = try await resolver("html").resolve(track, quality: "140")
            XCTFail("No se debe aceptar una página HTML como canción")
        } catch {
            XCTAssertEqual((error as NSError).domain, "FreeSong.Source")
        }
    }
    func testProxyIsIndependentOfDirectSourceFailure() async throws {
        let source = try await resolver("proxy").resolve(track, quality: "140")
        XCTAssertEqual(source.origin, "proxy")
        XCTAssertEqual(source.reportedDuration, 0, "La duración enviada por el cliente no verifica el archivo")
    }
    func testDeviceResolutionWorksWhenRelayAndProxyFail() async throws {
        let source = try await resolver("native").resolve(track, quality: "140")
        XCTAssertEqual(source.origin, "youtube")
        XCTAssertEqual(source.url.host, "media.test")
        XCTAssertEqual(source.videoId, track.id)
    }
}
