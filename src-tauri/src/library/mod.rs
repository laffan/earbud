//! Sketch Library: local storage and metadata.
//!
//! Layout on disk (under the platform app-data directory):
//!
//! ```text
//! library/
//!   earbud.sqlite3            metadata (titles, notes, transcriptions)
//!   sketches/<id>/
//!     recording.mov|mp4|webm  original capture, never modified after save
//!     analysis.wav            derived 22.05 kHz mono PCM for transcription
//!     transcription.mid       latest MIDI rendering of the notes
//!     exports/                friendly-named hard links handed to share/save
//! ```
//!
//! The library is deliberately free of Tauri types so it can be unit tested
//! with `cargo test` on any host.

pub mod models;
mod schema;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{Error, Result};
use models::*;

pub const MEDIA_STEM: &str = "recording";
pub const ANALYSIS_FILE: &str = "analysis.wav";
pub const MIDI_FILE: &str = "transcription.mid";
const EXPORTS_DIR: &str = "exports";
const DB_FILE: &str = "earbud.sqlite3";

/// What a raw byte upload from the frontend is for. Uploads never carry a
/// path, so the frontend cannot write outside a sketch directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    /// Append a chunk to the original recording (web capture backend only,
    /// and only while the sketch is still recording).
    MediaChunk,
    /// Replace the derived analysis WAV.
    Analysis,
    /// Replace the MIDI rendering of the current notes.
    Midi,
}

impl FileKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "media-chunk" => Ok(FileKind::MediaChunk),
            "analysis" => Ok(FileKind::Analysis),
            "midi" => Ok(FileKind::Midi),
            other => Err(Error::Invalid(format!("unknown file kind '{other}'"))),
        }
    }
}

pub struct Library {
    root: PathBuf,
    conn: Mutex<Connection>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Accept only the ids this library generates (uuid v4, simple format) so an
/// id can never be used to escape the sketches directory.
fn validate_id(id: &str) -> Result<()> {
    if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("invalid sketch id '{id}'")))
    }
}

fn validate_extension(ext: &str) -> Result<()> {
    if (1..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(Error::Invalid(format!("invalid media extension '{ext}'")))
    }
}

/// Turn a user title into something safe and pleasant as a file name.
pub fn safe_file_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut stem: String = trimmed.chars().take(80).collect();
    if stem.is_empty() {
        stem = "Earbud sketch".into();
    }
    stem
}

fn validate_notes(notes: &[PianoNote]) -> Result<()> {
    for (i, note) in notes.iter().enumerate() {
        note.validate()
            .map_err(|e| Error::Invalid(format!("note {i}: {e}")))?;
    }
    Ok(())
}

impl Library {
    /// Open (or create) the library rooted at `root`.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("sketches"))?;
        let mut conn = Connection::open(root.join(DB_FILE))?;
        schema::migrate(&mut conn)?;
        Ok(Library {
            root,
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock leaves SQLite itself consistent, so
        // recover the guard instead of poisoning the whole library.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn info(&self) -> LibraryInfo {
        LibraryInfo {
            root: self.root.display().to_string(),
            sketches_dir: self.root.join("sketches").display().to_string(),
            database_path: self.root.join(DB_FILE).display().to_string(),
        }
    }

    pub fn sketch_dir(&self, id: &str) -> PathBuf {
        self.root.join("sketches").join(id)
    }

    // ---------------------------------------------------------------- capture

    /// Reserve a sketch before recording starts. The row is persisted first so
    /// that a crash mid-recording still leaves a trace that can be recovered.
    pub fn create_sketch(&self, args: CreateSketchArgs) -> Result<CreatedSketch> {
        validate_extension(&args.media_extension)?;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = self.sketch_dir(&id);
        fs::create_dir_all(&dir)?;
        let media_file = format!("{MEDIA_STEM}.{}", args.media_extension.to_ascii_lowercase());
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO sketches (id, title, created_at, updated_at, status, media_file,
                                   media_mime, capture_backend)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                args.title.unwrap_or_default().trim(),
                now,
                SketchStatus::Recording.as_str(),
                media_file,
                args.media_mime,
                args.capture_backend,
            ],
        )?;
        Ok(CreatedSketch {
            media_path: dir.join(&media_file).display().to_string(),
            analysis_path: dir.join(ANALYSIS_FILE).display().to_string(),
            dir: dir.display().to_string(),
            id,
            created_at: now,
        })
    }

    /// Mark a recording as complete. Fails if the capture engine produced no
    /// data, in which case the caller should `discard_sketch`.
    pub fn finalize_sketch(&self, args: FinalizeSketchArgs) -> Result<Sketch> {
        validate_id(&args.id)?;
        let media = self.media_path(&args.id)?;
        let size = fs::metadata(&media).map(|m| m.len()).unwrap_or(0);
        if size == 0 {
            return Err(Error::Invalid(format!(
                "recording for sketch {} is empty or missing",
                args.id
            )));
        }
        let changed = self.conn().execute(
            "UPDATE sketches
                SET status = ?2, duration_ms = COALESCE(?3, duration_ms), has_video = ?4,
                    video_width = ?5, video_height = ?6, updated_at = ?7
              WHERE id = ?1",
            params![
                args.id,
                SketchStatus::Saved.as_str(),
                args.duration_ms,
                args.has_video,
                args.video_width,
                args.video_height,
                now_ms(),
            ],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(args.id));
        }
        Ok(self.get(&args.id)?.sketch)
    }

    /// Remove a sketch whose recording never produced data. Refuses to touch
    /// saved sketches: those can only go through `delete_sketch`.
    pub fn discard_sketch(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let status: Option<String> = self
            .conn()
            .query_row("SELECT status FROM sketches WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        match status.as_deref().map(SketchStatus::parse) {
            Some(SketchStatus::Recording) => self.delete_sketch(id),
            Some(SketchStatus::Saved) => Err(Error::Invalid(
                "refusing to discard a saved sketch".into(),
            )),
            None => Ok(()),
        }
    }

    fn media_path(&self, id: &str) -> Result<PathBuf> {
        let media_file: Option<String> = self
            .conn()
            .query_row("SELECT media_file FROM sketches WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound(id.to_string()))?;
        let media_file =
            media_file.ok_or_else(|| Error::Invalid(format!("sketch {id} has no media")))?;
        Ok(self.sketch_dir(id).join(media_file))
    }

    // ------------------------------------------------------------------ query

    fn row_to_sketch(&self, row: &Row<'_>) -> rusqlite::Result<Sketch> {
        let id: String = row.get("id")?;
        let dir = self.sketch_dir(&id);
        let media_file: Option<String> = row.get("media_file")?;
        let analysis = dir.join(ANALYSIS_FILE);
        let summary_json: Option<String> = row.get("summary_json")?;
        let edited: i64 = row.get("has_edits")?;
        let status: String = row.get("status")?;
        let tstatus: String = row.get("transcription_status")?;
        Ok(Sketch {
            title: row.get("title")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            status: SketchStatus::parse(&status),
            duration_ms: row.get("duration_ms")?,
            media_path: media_file.map(|f| dir.join(f).display().to_string()),
            media_mime: row.get("media_mime")?,
            has_video: row.get("has_video")?,
            video_width: row.get("video_width")?,
            video_height: row.get("video_height")?,
            analysis_path: analysis
                .is_file()
                .then(|| analysis.display().to_string()),
            text_notes: row.get("text_notes")?,
            transcription_status: TranscriptionStatus::parse(&tstatus),
            transcription_error: row.get("transcription_error")?,
            capture_backend: row.get("capture_backend")?,
            recovered: row.get("recovered")?,
            summary: summary_json.and_then(|s| serde_json::from_str(&s).ok()),
            has_edits: edited != 0,
            id,
        })
    }

    const SKETCH_SELECT: &'static str = "SELECT s.*, t.summary_json AS summary_json,
                (t.edited_notes_json IS NOT NULL) AS has_edits
           FROM sketches s LEFT JOIN transcriptions t ON t.sketch_id = s.id";

    /// All sketches, newest first.
    pub fn list(&self) -> Result<Vec<Sketch>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "{} ORDER BY s.created_at DESC, s.id",
            Self::SKETCH_SELECT
        ))?;
        let rows = stmt.query_map([], |row| self.row_to_sketch(row))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get(&self, id: &str) -> Result<SketchDetail> {
        validate_id(id)?;
        let conn = self.conn();
        let sketch = conn
            .query_row(
                &format!("{} WHERE s.id = ?1", Self::SKETCH_SELECT),
                [id],
                |row| self.row_to_sketch(row),
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(id.to_string()))?;
        let transcription = conn
            .query_row(
                "SELECT engine, engine_version, params_json, original_notes_json,
                        edited_notes_json, created_at, edited_at
                   FROM transcriptions WHERE sketch_id = ?1",
                [id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                    ))
                },
            )
            .optional()?
            .map(
                |(engine, engine_version, params, original, edited, created_at, edited_at)| {
                    Ok::<_, Error>(Transcription {
                        engine,
                        engine_version,
                        params: serde_json::from_str(&params)?,
                        original_notes: serde_json::from_str(&original)?,
                        edited_notes: edited.map(|e| serde_json::from_str(&e)).transpose()?,
                        created_at,
                        edited_at,
                    })
                },
            )
            .transpose()?;
        Ok(SketchDetail {
            sketch,
            transcription,
        })
    }

    // ----------------------------------------------------------------- update

    pub fn update(&self, args: UpdateSketchArgs) -> Result<Sketch> {
        validate_id(&args.id)?;
        let changed = self.conn().execute(
            "UPDATE sketches
                SET title = COALESCE(?2, title),
                    text_notes = COALESCE(?3, text_notes),
                    duration_ms = COALESCE(?4, duration_ms),
                    updated_at = ?5
              WHERE id = ?1",
            params![
                args.id,
                args.title.as_deref().map(str::trim),
                args.text_notes,
                args.duration_ms,
                now_ms()
            ],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(args.id));
        }
        Ok(self.get(&args.id)?.sketch)
    }

    /// Permanently delete a sketch and every file that belongs to it.
    pub fn delete_sketch(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        self.conn().execute("DELETE FROM sketches WHERE id = ?1", [id])?;
        let dir = self.sketch_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn set_transcription_status(
        &self,
        id: &str,
        status: TranscriptionStatus,
        error: Option<String>,
    ) -> Result<Sketch> {
        validate_id(id)?;
        let changed = self.conn().execute(
            "UPDATE sketches SET transcription_status = ?2, transcription_error = ?3,
                                 updated_at = ?4
              WHERE id = ?1",
            params![id, status.as_str(), error, now_ms()],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(id.to_string()));
        }
        Ok(self.get(id)?.sketch)
    }

    /// Store a fresh engine result. Replaces any previous engine output and
    /// discards user edits (the UI asks before re-transcribing an edited
    /// sketch). The recording itself is untouched.
    pub fn save_transcription(&self, args: SaveTranscriptionArgs) -> Result<SketchDetail> {
        validate_id(&args.id)?;
        validate_notes(&args.notes)?;
        let now = now_ms();
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let exists: bool = tx
                .query_row("SELECT 1 FROM sketches WHERE id = ?1", [&args.id], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if !exists {
                return Err(Error::NotFound(args.id));
            }
            tx.execute(
                "INSERT INTO transcriptions (sketch_id, engine, engine_version, params_json,
                                             original_notes_json, edited_notes_json,
                                             summary_json, created_at, edited_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL)
                 ON CONFLICT(sketch_id) DO UPDATE SET
                    engine = excluded.engine,
                    engine_version = excluded.engine_version,
                    params_json = excluded.params_json,
                    original_notes_json = excluded.original_notes_json,
                    edited_notes_json = NULL,
                    summary_json = excluded.summary_json,
                    created_at = excluded.created_at,
                    edited_at = NULL",
                params![
                    args.id,
                    args.engine,
                    args.engine_version,
                    serde_json::to_string(&args.params)?,
                    serde_json::to_string(&args.notes)?,
                    args.summary.map(|s| s.to_string()),
                    now,
                ],
            )?;
            tx.execute(
                "UPDATE sketches SET transcription_status = 'done', transcription_error = NULL,
                                     updated_at = ?2 WHERE id = ?1",
                params![args.id, now],
            )?;
            tx.commit()?;
        }
        self.get(&args.id)
    }

    /// Store user corrections alongside (never over) the engine output.
    pub fn save_edits(&self, args: SaveEditsArgs) -> Result<SketchDetail> {
        validate_id(&args.id)?;
        validate_notes(&args.notes)?;
        let now = now_ms();
        let changed = self.conn().execute(
            "UPDATE transcriptions
                SET edited_notes_json = ?2, summary_json = COALESCE(?3, summary_json),
                    edited_at = ?4
              WHERE sketch_id = ?1",
            params![
                args.id,
                serde_json::to_string(&args.notes)?,
                args.summary.map(|s| s.to_string()),
                now
            ],
        )?;
        if changed == 0 {
            return Err(Error::Invalid(format!(
                "sketch {} has no transcription to edit",
                args.id
            )));
        }
        self.conn().execute(
            "UPDATE sketches SET updated_at = ?2 WHERE id = ?1",
            params![args.id, now],
        )?;
        self.get(&args.id)
    }

    /// Drop user edits and fall back to the original engine output.
    pub fn reset_edits(&self, id: &str, summary: Option<serde_json::Value>) -> Result<SketchDetail> {
        validate_id(id)?;
        self.conn().execute(
            "UPDATE transcriptions
                SET edited_notes_json = NULL, edited_at = NULL,
                    summary_json = COALESCE(?2, summary_json)
              WHERE sketch_id = ?1",
            params![id, summary.map(|s| s.to_string())],
        )?;
        self.get(id)
    }

    // ------------------------------------------------------------------ files

    /// Write bytes uploaded from the frontend into a sketch directory.
    pub fn write_file(&self, id: &str, kind: FileKind, bytes: &[u8]) -> Result<PathBuf> {
        validate_id(id)?;
        let dir = self.sketch_dir(id);
        if !dir.is_dir() {
            return Err(Error::NotFound(id.to_string()));
        }
        let path = match kind {
            FileKind::MediaChunk => {
                let status: String = self.conn().query_row(
                    "SELECT status FROM sketches WHERE id = ?1",
                    [id],
                    |r| r.get(0),
                )?;
                // The original recording is immutable once saved.
                if SketchStatus::parse(&status) != SketchStatus::Recording {
                    return Err(Error::Invalid(
                        "the recording is already saved and cannot be modified".into(),
                    ));
                }
                let path = self.media_path(id)?;
                let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
                file.write_all(bytes)?;
                file.sync_data()?;
                return Ok(path);
            }
            FileKind::Analysis => dir.join(ANALYSIS_FILE),
            FileKind::Midi => dir.join(MIDI_FILE),
        };
        // Write-then-rename so readers never see a half-written file.
        let tmp = path.with_extension("partial");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(path)
    }

    /// Create friendly-named copies of the recording and MIDI file for
    /// sharing. Uses hard links where possible so large videos are not
    /// duplicated on disk.
    pub fn prepare_export(&self, id: &str, base_name: &str) -> Result<ExportBundle> {
        validate_id(id)?;
        let dir = self.sketch_dir(id);
        let exports = dir.join(EXPORTS_DIR);
        if exports.exists() {
            fs::remove_dir_all(&exports)?;
        }
        fs::create_dir_all(&exports)?;
        let stem = safe_file_stem(base_name);

        let link_or_copy = |src: &Path, dest: &Path| -> Result<()> {
            if fs::hard_link(src, dest).is_err() {
                fs::copy(src, dest)?;
            }
            Ok(())
        };

        let media = self.media_path(id)?;
        let media_out = if media.is_file() {
            let ext = media
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("mov")
                .to_string();
            let dest = exports.join(format!("{stem}.{ext}"));
            link_or_copy(&media, &dest)?;
            Some(dest.display().to_string())
        } else {
            None
        };

        let midi = dir.join(MIDI_FILE);
        let midi_out = if midi.is_file() {
            let dest = exports.join(format!("{stem}.mid"));
            link_or_copy(&midi, &dest)?;
            Some(dest.display().to_string())
        } else {
            None
        };

        Ok(ExportBundle {
            media_path: media_out,
            midi_path: midi_out,
        })
    }

    /// Copy a file that lives inside the library to a user-chosen destination
    /// (desktop "Save as…" flow).
    pub fn copy_out(&self, src: &Path, dest: &Path) -> Result<()> {
        let src = src.canonicalize()?;
        let root = self.root.canonicalize()?;
        if !src.starts_with(&root) {
            return Err(Error::Invalid("source is outside the sketch library".into()));
        }
        fs::copy(src, dest)?;
        Ok(())
    }

    // --------------------------------------------------------------- recovery

    /// Reconcile state after an unclean shutdown:
    /// * recordings that were still "recording" are kept if any media bytes
    ///   reached disk (AVFoundation writes movie fragments periodically, so a
    ///   killed recording is usually playable up to the last fragment);
    /// * transcriptions that were "running" go back to "pending".
    pub fn recover(&self) -> Result<RecoveryReport> {
        let mut report = RecoveryReport {
            recovered: vec![],
            discarded: vec![],
            requeued: vec![],
        };
        let interrupted: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM sketches WHERE status = 'recording'")?;
            let ids = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            ids
        };
        for id in interrupted {
            let size = self
                .media_path(&id)
                .ok()
                .and_then(|p| fs::metadata(p).ok())
                .map(|m| m.len())
                .unwrap_or(0);
            if size > 0 {
                self.conn().execute(
                    "UPDATE sketches SET status = 'saved', recovered = 1,
                            transcription_status = 'pending', updated_at = ?2
                      WHERE id = ?1",
                    params![id, now_ms()],
                )?;
                report.recovered.push(id);
            } else {
                self.delete_sketch(&id)?;
                report.discarded.push(id);
            }
        }
        {
            let conn = self.conn();
            let mut stmt =
                conn.prepare("SELECT id FROM sketches WHERE transcription_status = 'running'")?;
            report.requeued = stmt
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            conn.execute(
                "UPDATE sketches SET transcription_status = 'pending'
                  WHERE transcription_status = 'running'",
                [],
            )?;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests;
