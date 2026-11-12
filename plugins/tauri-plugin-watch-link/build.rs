// `available` is implemented in Rust on every platform; the rest are
// implemented in Swift (ios/Sources/WatchLinkPlugin.swift) and exist on iOS only.
// Each entry generates an `allow-<command>` permission.
const COMMANDS: &[&str] = &["available", "start", "stop", "begin_pairing", "end_pairing", "status"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
