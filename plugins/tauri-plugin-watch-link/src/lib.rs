//! Earbud watch link, native half.
//!
//! The Apple Watch app (`watch-app/`) sends recordings over three transports.
//! The local-network one is implemented in Rust in the app itself
//! (`src-tauri/src/watch_link`) and works on every platform. This plugin adds
//! the two that need Apple frameworks, on iOS:
//!
//! * **Bluetooth LE**: the iPhone/iPad advertises a GATT service and the Watch
//!   connects to it as a central (`CBPeripheralManager`).
//! * **WatchConnectivity**: `WCSession.transferFile` from the Watch to its
//!   paired iPhone.
//!
//! Both are implemented in Swift (`ios/Sources/WatchLinkPlugin.swift`) on top
//! of the `EarbudLink` package shared with the Watch app, and write what they
//! receive into the library inbox, where the app imports it.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_watch_link);

/// Whether the native transports exist on this platform.
#[tauri::command]
fn available() -> bool {
    cfg!(target_os = "ios")
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("watch-link")
        .invoke_handler(tauri::generate_handler![available])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_watch_link)?;
            Ok(())
        })
        .build()
}
