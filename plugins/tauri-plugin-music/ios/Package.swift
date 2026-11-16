// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-music",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-music",
      type: .static,
      targets: ["tauri-plugin-music"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-music",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
