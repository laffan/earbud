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
//!     notes-audio.wav         notes rendered with the synth (on export)
//!     take-audio.m4a|wav      the take's audio track (on export)
//!     exports/                friendly-named hard links handed to share/save
//!   (every take of a multi-track sketch has a folder like this of its own)
//!   inbox/                    recordings received from the Apple Watch,
//!                             waiting to be imported as sketches
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
/// Synthesized rendering of the current notes.
pub const NOTES_AUDIO_FILE: &str = "notes-audio.wav";
/// The take's audio track: `.m4a` from the native exporter, `.wav` otherwise.
pub const TAKE_AUDIO_STEM: &str = "take-audio";
const EXPORTS_DIR: &str = "exports";
const DB_FILE: &str = "earbud.sqlite3";
/// Received recordings waiting to be imported (see `crate::watch_link::inbox`).
pub const INBOX_DIR: &str = "inbox";

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
    /// Replace the synthesized rendering of the notes (WAV).
    NotesAudio,
    /// Replace the take's audio track (WAV; used where no native exporter exists).
    TakeAudio,
}

impl FileKind {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "media-chunk" => Ok(FileKind::MediaChunk),
            "analysis" => Ok(FileKind::Analysis),
            "midi" => Ok(FileKind::Midi),
            "notes-audio" => Ok(FileKind::NotesAudio),
            "take-audio" => Ok(FileKind::TakeAudio),
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

/// A fresh id in the same form as sketch ids (uuid v4, 32 hex characters).
fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
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
            inbox_dir: self.inbox_dir().display().to_string(),
        }
    }

    pub fn inbox_dir(&self) -> PathBuf {
        self.root.join(INBOX_DIR)
    }

    pub fn sketch_dir(&self, id: &str) -> PathBuf {
        self.root.join("sketches").join(id)
    }

    // ---------------------------------------------------------------- capture

    /// Reserve a sketch (or, with `parent_id`, a take for one of its tracks)
    /// before recording starts. The row is persisted first so that a crash
    /// mid-recording still leaves a trace that can be recovered.
    ///
    /// A take for a new track creates the track at once, with the take as
    /// the one it plays; a take for an existing track becomes the one it
    /// plays when it is finalized.
    pub fn create_sketch(&self, args: CreateSketchArgs) -> Result<CreatedSketch> {
        validate_extension(&args.media_extension)?;
        if let Some(parent) = &args.parent_id {
            validate_id(parent)?;
        }
        if let Some(track) = &args.track_id {
            validate_id(track)?;
            if args.parent_id.is_none() {
                return Err(Error::Invalid("a track can only be given with a parent sketch".into()));
            }
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let dir = self.sketch_dir(&id);
        fs::create_dir_all(&dir)?;
        let media_file = format!("{MEDIA_STEM}.{}", args.media_extension.to_ascii_lowercase());
        let now = now_ms();
        let inserted = (|| -> Result<String> {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let (track_id, new_track) = match (&args.parent_id, &args.track_id) {
                (None, _) => (new_id(), Some((0_i64, "Track 1".to_string()))),
                (Some(parent), Some(track)) => {
                    let owner: Option<String> = tx
                        .query_row("SELECT sketch_id FROM tracks WHERE id = ?1", [track], |r| r.get(0))
                        .optional()?;
                    if owner.as_deref() != Some(parent.as_str()) {
                        return Err(Error::NotFound(format!("track {track} of sketch {parent}")));
                    }
                    (track.clone(), None)
                }
                (Some(parent), None) => {
                    let position: i64 = tx.query_row(
                        "SELECT COALESCE(MAX(position) + 1, 0) FROM tracks WHERE sketch_id = ?1",
                        [parent],
                        |r| r.get(0),
                    )?;
                    (new_id(), Some((position, format!("Track {}", position + 1))))
                }
            };
            if let Some(parent) = &args.parent_id {
                let grandparent: Option<Option<String>> = tx
                    .query_row("SELECT parent_id FROM sketches WHERE id = ?1", [parent], |r| r.get(0))
                    .optional()?;
                match grandparent {
                    None => return Err(Error::NotFound(parent.clone())),
                    Some(Some(_)) => {
                        return Err(Error::Invalid("takes belong to a sketch, not to another take".into()))
                    }
                    Some(None) => {}
                }
            }
            tx.execute(
                "INSERT INTO sketches (id, title, created_at, updated_at, status, media_file,
                                       media_mime, capture_backend, parent_id, track_id)
                 VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    args.title.clone().unwrap_or_default().trim(),
                    now,
                    SketchStatus::Recording.as_str(),
                    media_file,
                    args.media_mime,
                    args.capture_backend,
                    args.parent_id,
                    track_id,
                ],
            )?;
            if let Some((position, name)) = new_track {
                let sketch = args.parent_id.clone().unwrap_or_else(|| id.clone());
                tx.execute(
                    "INSERT INTO tracks (id, sketch_id, position, name, take_id, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![track_id, sketch, position, name, id, now],
                )?;
            }
            tx.commit()?;
            Ok(track_id)
        })();
        let track_id = match inserted {
            Ok(track_id) => track_id,
            Err(error) => {
                let _ = fs::remove_dir_all(&dir);
                return Err(error);
            }
        };
        Ok(CreatedSketch {
            media_path: dir.join(&media_file).display().to_string(),
            analysis_path: dir.join(ANALYSIS_FILE).display().to_string(),
            dir: dir.display().to_string(),
            id,
            created_at: now,
            track_id,
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
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let changed = tx.execute(
                "UPDATE sketches
                    SET status = ?2, duration_ms = COALESCE(?3, duration_ms), has_video = ?4,
                        video_width = ?5, video_height = ?6, updated_at = ?7,
                        offset_ms = COALESCE(?8, offset_ms), count_in_ms = COALESCE(?9, count_in_ms)
                  WHERE id = ?1",
                params![
                    args.id,
                    SketchStatus::Saved.as_str(),
                    args.duration_ms,
                    args.has_video,
                    args.video_width,
                    args.video_height,
                    now_ms(),
                    args.offset_ms,
                    args.count_in_ms,
                ],
            )?;
            if changed == 0 {
                return Err(Error::NotFound(args.id));
            }
            // A new take becomes the one its track plays.
            tx.execute(
                "UPDATE tracks SET take_id = ?1
                  WHERE id = (SELECT track_id FROM sketches WHERE id = ?1)",
                [&args.id],
            )?;
            tx.commit()?;
        }
        Ok(self.get(&args.id)?.sketch)
    }

    /// Move a finished recording made elsewhere into the library as a saved
    /// sketch. `source` is moved, not copied, when it is on the same volume.
    ///
    /// Returns `Ok(None)` if a sketch with this id already exists (the same
    /// recording delivered twice); `source` is then left untouched.
    pub fn import_recording(&self, args: ImportRecordingArgs, source: &Path) -> Result<Option<Sketch>> {
        validate_id(&args.id)?;
        validate_extension(&args.media_extension)?;
        let exists: Option<String> = self
            .conn()
            .query_row("SELECT id FROM sketches WHERE id = ?1", [&args.id], |r| r.get(0))
            .optional()?;
        if exists.is_some() {
            return Ok(None);
        }
        let size = fs::metadata(source)?.len();
        if size == 0 {
            return Err(Error::Invalid(format!("received recording {} is empty", args.id)));
        }
        let dir = self.sketch_dir(&args.id);
        fs::create_dir_all(&dir)?;
        let media_file = format!("{MEDIA_STEM}.{}", args.media_extension.to_ascii_lowercase());
        let dest = dir.join(&media_file);
        if fs::rename(source, &dest).is_err() {
            // Different volume: copy, then remove the original.
            fs::copy(source, &dest)?;
            fs::remove_file(source)?;
        }
        let inserted = (|| -> rusqlite::Result<()> {
            let track_id = new_id();
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO sketches (id, title, created_at, updated_at, status, duration_ms,
                                       media_file, media_mime, has_video, capture_backend, track_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10)",
                params![
                    args.id,
                    args.title.trim(),
                    args.created_at,
                    now_ms(),
                    SketchStatus::Saved.as_str(),
                    args.duration_ms,
                    media_file,
                    args.media_mime,
                    args.capture_backend,
                    track_id,
                ],
            )?;
            tx.execute(
                "INSERT INTO tracks (id, sketch_id, position, name, take_id, created_at)
                 VALUES (?1, ?2, 0, 'Track 1', ?2, ?3)",
                params![track_id, args.id, args.created_at],
            )?;
            tx.commit()
        })();
        if let Err(error) = inserted {
            // Put the file back so the import can be retried.
            if fs::rename(&dest, source).is_ok() {
                let _ = fs::remove_dir_all(&dir);
            }
            return Err(error.into());
        }
        Ok(Some(self.get(&args.id)?.sketch))
    }

    /// Remove a sketch (or take) whose recording never produced data. Refuses
    /// to touch saved recordings: those can only go through `delete_sketch`
    /// or `delete_take`.
    pub fn discard_sketch(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let row: Option<(String, Option<String>)> = self
            .conn()
            .query_row("SELECT status, parent_id FROM sketches WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let status = row.as_ref().map(|(status, _)| status.as_str());
        let is_take = row.as_ref().is_some_and(|(_, parent)| parent.is_some());
        match status.map(SketchStatus::parse) {
            Some(SketchStatus::Recording) if is_take => self.remove_take(id),
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
            crop_start_ms: row.get("crop_start_ms")?,
            crop_end_ms: row.get("crop_end_ms")?,
            parent_id: row.get("parent_id")?,
            track_id: row.get("track_id")?,
            offset_ms: row.get("offset_ms")?,
            count_in_ms: row.get("count_in_ms")?,
            id,
        })
    }

    /// The tracks of a sketch, in order, each with its takes (oldest first).
    fn tracks_of(&self, conn: &Connection, sketch_id: &str) -> Result<Vec<Track>> {
        let mut stmt = conn.prepare(
            "SELECT id, sketch_id, position, name, take_id, muted, solo, collapsed, created_at
               FROM tracks WHERE sketch_id = ?1 ORDER BY position, created_at",
        )?;
        let tracks = stmt
            .query_map([sketch_id], |r| {
                Ok(Track {
                    id: r.get(0)?,
                    sketch_id: r.get(1)?,
                    position: r.get(2)?,
                    name: r.get(3)?,
                    take_id: r.get(4)?,
                    muted: r.get(5)?,
                    solo: r.get(6)?,
                    collapsed: r.get(7)?,
                    created_at: r.get(8)?,
                    takes: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut takes_stmt = conn.prepare(&format!(
            "{} WHERE s.track_id = ?1 ORDER BY s.created_at, s.id",
            Self::SKETCH_SELECT
        ))?;
        tracks
            .into_iter()
            .map(|mut track| {
                track.takes = takes_stmt
                    .query_map([&track.id], |row| self.row_to_sketch(row))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(track)
            })
            .collect()
    }

    const SKETCH_SELECT: &'static str = "SELECT s.*, t.summary_json AS summary_json,
                (t.edited_notes_json IS NOT NULL) AS has_edits
           FROM sketches s LEFT JOIN transcriptions t ON t.sketch_id = s.id";

    /// All sketches and their takes, newest first. Takes have a `parent_id`.
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
        let tracks = if sketch.parent_id.is_none() {
            self.tracks_of(&conn, id)?
        } else {
            Vec::new()
        };
        Ok(SketchDetail {
            sketch,
            transcription,
            tracks,
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

    /// Set (or clear, with `None`) the playback crop range. Only affects
    /// playback; the recording is untouched.
    pub fn set_crop(&self, id: &str, start_ms: Option<i64>, end_ms: Option<i64>) -> Result<Sketch> {
        validate_id(id)?;
        if let Some(start) = start_ms {
            if start < 0 {
                return Err(Error::Invalid("crop start must not be negative".into()));
            }
        }
        if let (Some(start), Some(end)) = (start_ms, end_ms) {
            if end - start < 100 {
                return Err(Error::Invalid("crop range is too short".into()));
            }
        }
        let changed = self.conn().execute(
            "UPDATE sketches SET crop_start_ms = ?2, crop_end_ms = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, start_ms, end_ms, now_ms()],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(id.to_string()));
        }
        Ok(self.get(id)?.sketch)
    }

    /// Permanently delete a sketch, all of its tracks and takes, and every
    /// file that belongs to them. Given a take, deletes only that take.
    pub fn delete_sketch(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let parent: Option<Option<String>> = self
            .conn()
            .query_row("SELECT parent_id FROM sketches WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        if let Some(Some(_)) = parent {
            return self.remove_take(id);
        }
        let takes: Vec<String> = {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let takes = {
                let mut stmt = tx.prepare("SELECT id FROM sketches WHERE parent_id = ?1")?;
                let ids = stmt
                    .query_map([id], |r| r.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?;
                ids
            };
            tx.execute("DELETE FROM sketches WHERE parent_id = ?1", [id])?;
            tx.execute("DELETE FROM sketches WHERE id = ?1", [id])?;
            tx.commit()?;
            takes
        };
        for dir in takes.iter().map(|t| self.sketch_dir(t)).chain([self.sketch_dir(id)]) {
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
        }
        Ok(())
    }

    // ----------------------------------------------------------------- tracks

    /// Rename, mute, solo, collapse a track, choose which of its takes plays,
    /// or move that take on the timeline.
    pub fn update_track(&self, args: UpdateTrackArgs) -> Result<Track> {
        validate_id(&args.id)?;
        let sketch_id: String = self
            .conn()
            .query_row("SELECT sketch_id FROM tracks WHERE id = ?1", [&args.id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound(args.id.clone()))?;
        if let Some(take) = &args.take_id {
            validate_id(take)?;
            let row: Option<(Option<String>, String)> = self
                .conn()
                .query_row("SELECT track_id, status FROM sketches WHERE id = ?1", [take], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            match row {
                Some((Some(track), status)) if track == args.id => {
                    if SketchStatus::parse(&status) != SketchStatus::Saved {
                        return Err(Error::Invalid("that take is still being recorded".into()));
                    }
                }
                _ => return Err(Error::NotFound(format!("take {take} of track {}", args.id))),
            }
        }
        let name = args.name.as_deref().map(|n| n.trim().chars().take(60).collect::<String>());
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            tx.execute(
                "UPDATE tracks
                    SET name = COALESCE(?2, name), muted = COALESCE(?3, muted),
                        solo = COALESCE(?4, solo), collapsed = COALESCE(?5, collapsed),
                        take_id = COALESCE(?6, take_id)
                  WHERE id = ?1",
                params![args.id, name, args.muted, args.solo, args.collapsed, args.take_id],
            )?;
            if let Some(offset) = args.offset_ms {
                tx.execute(
                    "UPDATE sketches SET offset_ms = ?2, updated_at = ?3
                      WHERE id = (SELECT take_id FROM tracks WHERE id = ?1)",
                    params![args.id, offset, now_ms()],
                )?;
            }
            tx.commit()?;
        }
        let conn = self.conn();
        self.tracks_of(&conn, &sketch_id)?
            .into_iter()
            .find(|t| t.id == args.id)
            .ok_or_else(|| Error::NotFound(args.id.clone()))
    }

    /// Delete a track and all of its takes. The track that holds the
    /// sketch's own (first) recording cannot be deleted; delete the sketch.
    pub fn delete_track(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let takes: Vec<(String, Option<String>)> = {
            let conn = self.conn();
            let exists: Option<String> = conn
                .query_row("SELECT id FROM tracks WHERE id = ?1", [id], |r| r.get(0))
                .optional()?;
            if exists.is_none() {
                return Err(Error::NotFound(id.to_string()));
            }
            let mut stmt = conn.prepare("SELECT id, parent_id FROM sketches WHERE track_id = ?1")?;
            let rows = stmt
                .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        if takes.iter().any(|(_, parent)| parent.is_none()) {
            return Err(Error::Invalid(
                "this track holds the sketch's first recording; delete the sketch instead".into(),
            ));
        }
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM sketches WHERE track_id = ?1", [id])?;
            tx.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
            tx.commit()?;
        }
        for (take, _) in takes {
            let dir = self.sketch_dir(&take);
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
        }
        Ok(())
    }

    /// Delete one take of a track. Its track then plays its latest remaining
    /// take, and a track left without takes is removed. The sketch's own
    /// (first) recording cannot be deleted this way; delete the sketch.
    pub fn delete_take(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        let parent: Option<String> = self
            .conn()
            .query_row("SELECT parent_id FROM sketches WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound(id.to_string()))?;
        if parent.is_none() {
            return Err(Error::Invalid(
                "this is the sketch's first recording; delete the sketch instead".into(),
            ));
        }
        self.remove_take(id)
    }

    fn remove_take(&self, id: &str) -> Result<()> {
        let track: Option<String> = {
            let conn = self.conn();
            let track: Option<Option<String>> = conn
                .query_row("SELECT track_id FROM sketches WHERE id = ?1", [id], |r| r.get(0))
                .optional()?;
            conn.execute("DELETE FROM sketches WHERE id = ?1", [id])?;
            track.flatten()
        };
        let dir = self.sketch_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        if let Some(track) = track {
            self.repair_track(&track)?;
        }
        Ok(())
    }

    /// After a take is gone: play the latest remaining take, or drop the track.
    fn repair_track(&self, track: &str) -> Result<()> {
        let conn = self.conn();
        let remaining: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT id FROM sketches WHERE track_id = ?1
                  ORDER BY (status = 'saved') DESC, created_at DESC",
            )?;
            let ids = stmt
                .query_map([track], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
            ids
        };
        match remaining.first() {
            None => {
                conn.execute("DELETE FROM tracks WHERE id = ?1", [track])?;
            }
            Some(latest) => {
                conn.execute(
                    "UPDATE tracks SET take_id = ?2
                      WHERE id = ?1 AND take_id NOT IN (SELECT id FROM sketches WHERE track_id = ?1)",
                    params![track, latest],
                )?;
            }
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
            FileKind::NotesAudio => dir.join(NOTES_AUDIO_FILE),
            FileKind::TakeAudio => dir.join(format!("{TAKE_AUDIO_STEM}.wav")),
        };
        // Write-then-rename so readers never see a half-written file.
        let tmp = path.with_extension("partial");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(path)
    }

    /// Create friendly-named copies of the requested files for sharing. Uses
    /// hard links where possible so large videos are not duplicated on disk.
    /// Kinds without a source file are reported in `missing`.
    pub fn prepare_export(
        &self,
        id: &str,
        base_name: &str,
        kinds: &[ExportKind],
    ) -> Result<ExportBundle> {
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
        let extension = |path: &Path, fallback: &str| -> String {
            path.extension()
                .and_then(|e| e.to_str())
                .unwrap_or(fallback)
                .to_ascii_lowercase()
        };

        let mut files = Vec::new();
        let mut missing = Vec::new();
        let mut seen = Vec::new();
        for &kind in kinds {
            if seen.contains(&kind) {
                continue;
            }
            seen.push(kind);
            let source = match kind {
                ExportKind::Recording => Some(self.media_path(id)?),
                ExportKind::Audio => {
                    let m4a = dir.join(format!("{TAKE_AUDIO_STEM}.m4a"));
                    let wav = dir.join(format!("{TAKE_AUDIO_STEM}.wav"));
                    Some(if m4a.is_file() { m4a } else { wav })
                }
                ExportKind::NotesAudio => Some(dir.join(NOTES_AUDIO_FILE)),
                ExportKind::Midi => Some(dir.join(MIDI_FILE)),
            }
            .filter(|p| p.is_file());
            let Some(source) = source else {
                missing.push(kind);
                continue;
            };
            let name = match kind {
                ExportKind::Recording => format!("{stem}.{}", extension(&source, "mov")),
                ExportKind::Audio => format!("{stem} (audio).{}", extension(&source, "m4a")),
                ExportKind::NotesAudio => format!("{stem} (notes).wav"),
                ExportKind::Midi => format!("{stem}.mid"),
            };
            let dest = exports.join(name);
            link_or_copy(&source, &dest)?;
            files.push(ExportedFile {
                kind,
                path: dest.display().to_string(),
            });
        }
        Ok(ExportBundle { files, missing })
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
                // A take goes on its own; a sketch with all of its tracks.
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
