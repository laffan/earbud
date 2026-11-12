// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-watch-link",
  platforms: [
    .macOS(.v12),
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-watch-link",
      type: .static,
      targets: ["tauri-plugin-watch-link"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    // The protocol, shared with the Apple Watch app.
    .package(name: "EarbudLink", path: "../../../watch-app/Packages/EarbudLink"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-watch-link",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "EarbudLink", package: "EarbudLink"),
      ],
      path: "Sources")
  ]
)
