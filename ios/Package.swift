// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FreeSongAudioPolicy",
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [.library(name: "FreeSongAudioPolicy", targets: ["FreeSongAudioPolicy"])],
    targets: [
        .target(name: "FreeSongAudioPolicy", path: "App/App", exclude: ["AppDelegate.swift", "SceneDelegate.swift", "FreeSongAudioPlugin.swift", "Assets.xcassets", "Base.lproj", "Info.plist"], sources: ["AudioPolicy.swift", "AudioSourceResolver.swift"]),
        .testTarget(name: "AudioPolicyTests", dependencies: ["FreeSongAudioPolicy"], path: "AudioPolicyTests")
    ]
)
