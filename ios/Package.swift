// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FreeSongAudioPolicy",
    products: [.library(name: "FreeSongAudioPolicy", targets: ["FreeSongAudioPolicy"])],
    targets: [
        .target(name: "FreeSongAudioPolicy", path: "App/App", exclude: ["AppDelegate.swift", "SceneDelegate.swift", "FreeSongAudioPlugin.swift", "AudioSourceResolver.swift", "Assets.xcassets", "Base.lproj", "Info.plist"], sources: ["AudioPolicy.swift"]),
        .testTarget(name: "AudioPolicyTests", dependencies: ["FreeSongAudioPolicy"], path: "AudioPolicyTests")
    ]
)
