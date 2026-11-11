//! Earbud Capture Engine.
//!
//! On iOS every recording command is implemented in Swift on top of
//! AVFoundation (`ios/Sources/CapturePlugin.swift`). The camera preview is a
//! native `AVCaptureVideoPreviewLayer` placed *behind* a transparent webview,
//! so no video frames ever cross the JavaScript bridge; the recording is
//! written straight to disk by `AVCaptureMovieFileOutput`, which keeps audio
//! and video on one clock.
//!
//! Commands that are not handled by the Rust invoke handler below are routed
//! by Tauri to the Swift plugin (`snake_case` → `lowerCamelCase`). On
//! desktop the frontend falls back to its WebRTC/MediaRecorder backend, which
//! is selected by checking [`Capabilities`].

use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_capture);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Native synchronized audio/video capture is available.
    pub native_capture: bool,
    /// Native extraction of the analysis WAV from a recording is available.
    pub native_audio_extraction: bool,
    /// Native share sheet is available.
    pub native_share: bool,
    pub platform: &'static str,
}

#[tauri::command]
fn capabilities() -> Capabilities {
    let ios = cfg!(target_os = "ios");
    Capabilities {
        native_capture: ios,
        native_audio_extraction: ios,
        native_share: ios,
        platform: std::env::consts::OS,
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("capture")
        .invoke_handler(tauri::generate_handler![capabilities])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_capture)?;
            Ok(())
        })
        .build()
}
