//! Earbud application entry point.
//!
//! Module map (see docs/ARCHITECTURE.md):
//! * `library`  – Sketch Library: SQLite metadata + filesystem recordings.
//! * `commands` – Tauri IPC surface used by the Svelte UI.
//! * Capture Engine – `tauri-plugin-capture` (native AVFoundation on iOS).
//! * Transcription / Music engines live in the frontend (`src/lib`).

mod commands;
mod error;
pub mod library;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_capture::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("library");
            let library = library::Library::open(&root)
                .map_err(|e| format!("failed to open sketch library at {}: {e}", root.display()))?;
            app.manage(library);
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
            commands::set_crop,
            commands::set_transcription_status,
            commands::save_transcription,
            commands::save_edits,
            commands::reset_edits,
            commands::write_sketch_file,
            commands::prepare_export,
            commands::copy_out,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Earbud");
}
