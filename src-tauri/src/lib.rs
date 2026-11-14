//! Earbud application entry point.
//!
//! Module map (see docs/ARCHITECTURE.md):
//! * `library`  – Sketch Library: SQLite metadata + filesystem recordings.
//! * `commands` – Tauri IPC surface used by the Svelte UI.
//! * `watch_link` – receiving recordings from the Apple Watch app (local
//!   network here; Bluetooth and the paired iPhone in `tauri-plugin-watch-link`).
//! * Capture Engine – `tauri-plugin-capture` (native AVFoundation on iOS).
//! * Transcription / Music engines live in the frontend (`src/lib`).

mod commands;
mod error;
pub mod library;
pub mod watch_link;

use tauri::{AppHandle, Emitter, Manager};

use library::Library;
use watch_link::{WatchLink, WatchLinkEvent};

/// Forward watch-link events to the UI, and import a recording as soon as it
/// reaches the inbox (on the connection's thread, not the UI's).
fn on_watch_event(handle: &AppHandle, event: WatchLinkEvent) {
    let received = matches!(event, WatchLinkEvent::Received { .. });
    let _ = handle.emit("watch-link", &event);
    if !received {
        return;
    }
    let (Some(library), Some(watch)) = (handle.try_state::<Library>(), handle.try_state::<WatchLink>()) else {
        return;
    };
    match watch.import_inbox(&library) {
        Ok(report) => {
            if !report.imported.is_empty() {
                let _ = handle.emit("watch-link", WatchLinkEvent::Imported { sketches: report.imported });
            }
            for message in report.failed {
                let _ = handle.emit("watch-link", WatchLinkEvent::Error { message });
            }
        }
        Err(error) => {
            let _ = handle.emit(
                "watch-link",
                WatchLinkEvent::Error {
                    message: format!("Could not import a recording from the Watch: {error}"),
                },
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_capture::init())
        .plugin(tauri_plugin_watch_link::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("library");
            let library = Library::open(&root)
                .map_err(|e| format!("failed to open sketch library at {}: {e}", root.display()))?;
            app.manage(library);
            let handle = app.handle().clone();
            let watch = WatchLink::open(
                &root,
                watch_link::protocol::DEFAULT_PORT,
                Box::new(move |event| on_watch_event(&handle, event)),
            )
            .map_err(|e| format!("failed to set up the Apple Watch receiver: {e}"))?;
            app.manage(watch);
            app.state::<WatchLink>().start_if_enabled();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_info,
            commands::recover_sketches,
            commands::list_sketches,
            commands::get_sketch,
            commands::create_sketch,
            commands::finalize_sketch,
            commands::discard_sketch,
            commands::update_sketch,
            commands::delete_sketch,
            commands::update_track,
            commands::delete_track,
            commands::delete_take,
            commands::set_crop,
            commands::set_transcription_status,
            commands::save_transcription,
            commands::save_edits,
            commands::reset_edits,
            commands::write_sketch_file,
            commands::prepare_export,
            commands::copy_out,
            commands::watch_link_status,
            commands::watch_link_set_enabled,
            commands::watch_link_set_name,
            commands::watch_link_begin_pairing,
            commands::watch_link_end_pairing,
            commands::watch_link_record_pairing,
            commands::watch_link_reset,
            commands::watch_link_resume,
            commands::import_watch_inbox,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Earbud");
}
