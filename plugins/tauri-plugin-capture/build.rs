// Commands implemented natively in Swift (ios/Sources/CapturePlugin.swift)
// plus `capabilities`, which is implemented in Rust on every platform.
// Each entry generates an `allow-<command>` permission.
const COMMANDS: &[&str] = &[
    "capabilities",
    "check_permissions",
    "request_permissions",
    "open_app_settings",
    "start_recording",
    "stop_recording",
    "extract_analysis_audio",
    "share_files",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
