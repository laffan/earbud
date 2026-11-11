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
/// * `x-file-kind`: `media-chunk` | `analysis` | `midi`
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
) -> Result<ExportBundle> {
    library.prepare_export(&id, &base_name)
}

/// Desktop "Save as…": copy a library file to a path chosen in a native
/// save dialog.
#[tauri::command]
pub async fn copy_out(library: State<'_, Library>, src: String, dest: String) -> Result<()> {
    library.copy_out(&PathBuf::from(src), &PathBuf::from(dest))
}
