// swift-tools-version:5.5
import PackageDescription

// The protocol between the Earbud Apple Watch app and the devices it sends to.
//
// Used by:
//  • the watchOS app (watch-app/EarbudWatch): the sending side;
//  • the iOS receiver in Earbud (plugins/tauri-plugin-watch-link): Bluetooth and
//    WatchConnectivity. The local-network receiver is written in Rust
//    (src-tauri/src/watch_link) against the same wire format and fixtures.
//
// No dependencies, so it builds for watchOS, iOS, and macOS (`swift test` on a Mac
// runs the framing and model tests).
let package = Package(
    name: "EarbudLink",
    platforms: [
        .iOS(.v15),
        .watchOS(.v8),
        .macOS(.v12),
    ],
    products: [
        .library(name: "EarbudLink", targets: ["EarbudLink"]),
    ],
    targets: [
        .target(name: "EarbudLink", path: "Sources/EarbudLink"),
        .testTarget(
            name: "EarbudLinkTests",
            dependencies: ["EarbudLink"],
            path: "Tests/EarbudLinkTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
