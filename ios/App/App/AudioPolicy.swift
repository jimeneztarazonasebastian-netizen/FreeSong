import Foundation

enum AudioPolicy {
    static func duration(actual: Double, metadata: Double, source: Double = 0) -> Double {
        if actual.isFinite && actual > 0 {
            // Corregir el duplicado solo si el catálogo y el archivo concuerdan.
            if metadata > 0 && source > 0 && abs(metadata - source) <= 2 &&
                abs(actual - source * 2) <= 1 { return source }
            return actual
        }
        return metadata.isFinite ? max(0, metadata) : 0
    }

    static func preloadIndices(current: Int, count: Int, repeatMode: String, shuffled: Bool) -> [Int] {
        guard count > 1, (0..<count).contains(current), repeatMode != "one" else { return [] }
        if shuffled { return Array((0..<count).filter { $0 != current }.shuffled().prefix(3)) }
        let remaining = repeatMode == "all" ? count - 1 : count - current - 1
        return (1..<(min(3, remaining) + 1)).map { (current + $0) % count }
    }

    static func nextIndex(current: Int, count: Int, repeatMode: String, manual: Bool) -> Int? {
        guard count > 0, current >= 0, current < count else { return nil }
        if repeatMode == "one" && !manual { return current }
        if current + 1 < count { return current + 1 }
        return repeatMode != "off" ? 0 : nil
    }

    static func fadeGains(progress: Double, volume: Float) -> (outgoing: Float, incoming: Float) {
        let p = progress.isFinite ? min(1, max(0, progress)) : 0
        let level = volume.isFinite ? min(1, max(0, volume)) : 0
        return (level * Float(cos(p * .pi / 2)), level * Float(sin(p * .pi / 2)))
    }
}
