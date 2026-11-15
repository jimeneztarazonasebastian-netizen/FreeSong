import XCTest
@testable import FreeSongAudioPolicy

final class AudioPolicyTests: XCTestCase {
    func testActualDurationNeverTruncatesToSearchMetadata() {
        XCTAssertEqual(AudioPolicy.duration(actual: 380.975, metadata: 191), 380.975)
        XCTAssertEqual(AudioPolicy.duration(actual: 191.3, metadata: 191), 191.3)
        XCTAssertEqual(AudioPolicy.duration(actual: .nan, metadata: 191), 191)
        XCTAssertEqual(AudioPolicy.duration(actual: .infinity, metadata: -1), 0)
    }
    func testQueueBoundariesAndManualSkipWhileRepeatingOne() {
        XCTAssertNil(AudioPolicy.nextIndex(current: 0, count: 0, repeatMode: "all", manual: false))
        XCTAssertEqual(AudioPolicy.nextIndex(current: 0, count: 3, repeatMode: "one", manual: false), 0)
        XCTAssertEqual(AudioPolicy.nextIndex(current: 0, count: 3, repeatMode: "one", manual: true), 1)
        XCTAssertNil(AudioPolicy.nextIndex(current: 2, count: 3, repeatMode: "off", manual: false))
        XCTAssertEqual(AudioPolicy.nextIndex(current: 2, count: 3, repeatMode: "all", manual: false), 0)
        XCTAssertNil(AudioPolicy.nextIndex(current: -1, count: 3, repeatMode: "all", manual: false))
    }
    func testEqualPowerCrossfadeAndClamping() {
        let start = AudioPolicy.fadeGains(progress: -1, volume: 0.88)
        XCTAssertEqual(start.outgoing, 0.88)
        XCTAssertEqual(start.incoming, 0)
        let mid = AudioPolicy.fadeGains(progress: 0.5, volume: 0.88)
        XCTAssertEqual(mid.outgoing * mid.outgoing + mid.incoming * mid.incoming, 0.88 * 0.88, accuracy: 0.0001)
        let end = AudioPolicy.fadeGains(progress: 2, volume: 1)
        XCTAssertEqual(end.outgoing, 0, accuracy: 0.0001)
        XCTAssertEqual(end.incoming, 1)
        XCTAssertTrue(AudioPolicy.fadeGains(progress: .nan, volume: .infinity).outgoing.isFinite)
    }
}
