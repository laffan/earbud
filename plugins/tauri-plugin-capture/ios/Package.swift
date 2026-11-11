// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-capture",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-capture",
      type: .static,
      targets: ["tauri-plugin-capture"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-capture",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
