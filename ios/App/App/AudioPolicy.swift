import Foundation

enum AudioPolicy {
    static func duration(actual: Double, metadata: Double) -> Double {
        if actual.isFinite && actual > 0 { return actual }
        return metadata.isFinite ? max(0, metadata) : 0
    }

    static func nextIndex(current: Int, count: Int, repeatMode: String, manual: Bool) -> Int? {
        guard count > 0, current >= 0, current < count else { return nil }
        if repeatMode == "one" && !manual { return current }
        if current + 1 < count { return current + 1 }
        return repeatMode == "all" ? 0 : nil
    }

    static func fadeGains(progress: Double, volume: Float) -> (outgoing: Float, incoming: Float) {
        let p = progress.isFinite ? min(1, max(0, progress)) : 0
        let level = volume.isFinite ? min(1, max(0, volume)) : 0
        return (level * Float(cos(p * .pi / 2)), level * Float(sin(p * .pi / 2)))
    }
}
