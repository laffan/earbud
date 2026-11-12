//! Tauri command layer: a thin, typed bridge from the UI to the Sketch Library.
//!
//! Commands are `async` so file and database work runs on Tauri's async
//! runtime instead of the main (UI) thread.

use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use crate::error::{Error, Result};
use crate::library::models::*;
use crate::library::{FileKind, Library};
use crate::watch_link::{ImportReport, WatchLink, WatchLinkStatus};

#[tauri::command]
pub async fn library_info(library: State<'_, Library>) -> Result<LibraryInfo> {
    Ok(library.info())
}

#[tauri::command]
pub async fn recover_sketches(library: State<'_, Library>) -> Result<RecoveryReport> {
    library.recover()
}

#[tauri::command]
pub async fn list_sketches(library: State<'_, Library>) -> Result<Vec<Sketch>> {
    library.list()
}

#[tauri::command]
pub async fn get_sketch(library: State<'_, Library>, id: String) -> Result<SketchDetail> {
    library.get(&id)
}

#[tauri::command]
pub async fn create_sketch(
    library: State<'_, Library>,
    args: CreateSketchArgs,
) -> Result<CreatedSketch> {
    library.create_sketch(args)
}

#[tauri::command]
pub async fn finalize_sketch(
    library: State<'_, Library>,
    args: FinalizeSketchArgs,
) -> Result<Sketch> {
    library.finalize_sketch(args)
}

#[tauri::command]
pub async fn discard_sketch(library: State<'_, Library>, id: String) -> Result<()> {
    library.discard_sketch(&id)
}

#[tauri::command]
pub async fn update_sketch(library: State<'_, Library>, args: UpdateSketchArgs) -> Result<Sketch> {
    library.update(args)
}

#[tauri::command]
pub async fn set_crop(
    library: State<'_, Library>,
    id: String,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Sketch> {
    library.set_crop(&id, start_ms, end_ms)
}

#[tauri::command]
pub async fn delete_sketch(library: State<'_, Library>, id: String) -> Result<()> {
    library.delete_sketch(&id)
}

#[tauri::command]
pub async fn set_transcription_status(
    library: State<'_, Library>,
    id: String,
    status: TranscriptionStatus,
    error: Option<String>,
) -> Result<Sketch> {
    library.set_transcription_status(&id, status, error)
}

#[tauri::command]
pub async fn save_transcription(
    library: State<'_, Library>,
    args: SaveTranscriptionArgs,
) -> Result<SketchDetail> {
    library.save_transcription(args)
}

#[tauri::command]
pub async fn save_edits(library: State<'_, Library>, args: SaveEditsArgs) -> Result<SketchDetail> {
    library.save_edits(args)
}

#[tauri::command]
pub async fn reset_edits(
    library: State<'_, Library>,
    id: String,
    summary: Option<serde_json::Value>,
) -> Result<SketchDetail> {
    library.reset_edits(&id, summary)
}

/// Binary upload. The body is raw bytes (no JSON/base64 overhead); routing
/// information travels in headers:
/// * `x-sketch-id`: target sketch
/// * `x-file-kind`: `media-chunk` | `analysis` | `midi` | `notes-audio` | `take-audio`
///
/// Returns the absolute path that was written.
#[tauri::command]
pub async fn write_sketch_file(
    library: State<'_, Library>,
    request: Request<'_>,
) -> Result<String> {
    let header = |name: &str| -> Result<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| Error::Invalid(format!("missing header {name}")))
    };
    let id = header("x-sketch-id")?;
    let kind = FileKind::parse(&header("x-file-kind")?)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err(Error::Invalid("expected a raw binary body".into()));
        }
    };
    let path = library.write_file(&id, kind, bytes)?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn prepare_export(
    library: State<'_, Library>,
    id: String,
    base_name: String,
    kinds: Vec<ExportKind>,
) -> Result<ExportBundle> {
    library.prepare_export(&id, &base_name, &kinds)
}

/// Desktop "Save as…": copy a library file to a path chosen in a native
/// save dialog.
#[tauri::command]
pub async fn copy_out(library: State<'_, Library>, src: String, dest: String) -> Result<()> {
    library.copy_out(&PathBuf::from(src), &PathBuf::from(dest))
}

// ------------------------------------------------------------- Apple Watch

#[tauri::command]
pub async fn watch_link_status(watch: State<'_, WatchLink>) -> Result<WatchLinkStatus> {
    Ok(watch.status())
}

#[tauri::command]
pub async fn watch_link_set_enabled(watch: State<'_, WatchLink>, enabled: bool) -> Result<WatchLinkStatus> {
    watch.set_enabled(enabled)
}

#[tauri::command]
pub async fn watch_link_set_name(watch: State<'_, WatchLink>, name: String) -> Result<WatchLinkStatus> {
    watch.set_display_name(&name)
}

#[tauri::command]
pub async fn watch_link_begin_pairing(watch: State<'_, WatchLink>) -> Result<WatchLinkStatus> {
    watch.begin_pairing()
}

#[tauri::command]
pub async fn watch_link_end_pairing(watch: State<'_, WatchLink>) -> Result<WatchLinkStatus> {
    Ok(watch.end_pairing())
}

/// Bluetooth pairing happens in the Swift plugin; it reports back here.
#[tauri::command]
pub async fn watch_link_record_pairing(
    watch: State<'_, WatchLink>,
    watch_name: String,
    via: String,
) -> Result<WatchLinkStatus> {
    Ok(watch.record_pairing(&watch_name, &via))
}

#[tauri::command]
pub async fn watch_link_reset(watch: State<'_, WatchLink>) -> Result<WatchLinkStatus> {
    watch.reset_pairing()
}

#[tauri::command]
pub async fn watch_link_resume(watch: State<'_, WatchLink>) -> Result<WatchLinkStatus> {
    Ok(watch.resume())
}

#[tauri::command]
pub async fn import_watch_inbox(
    library: State<'_, Library>,
    watch: State<'_, WatchLink>,
) -> Result<ImportReport> {
    watch.import_inbox(&library)
}
