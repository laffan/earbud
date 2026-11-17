//! The sample library: short sounds cut from recordings.
//!
//! ```text
//! library/samples/<id>/sample.wav   the cut audio, written once
//! ```
//!
//! A sample's settings (trim, envelope, effects, root note) are JSON the
//! frontend renders the sound with; the stored audio never changes. A sketch
//! may play its notes with a sample (`note_sample_id`); deleting the sample
//! sends those sketches back to the built-in piano. Rhythm patterns name the
//! samples of their pads inside their JSON, and fall back to their pads'
//! own sounds when one is gone.

use std::fs;
use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, Row};

use super::models::{CreateSampleArgs, Sample, Sketch, UpdateSampleArgs};
use super::{new_id, now_ms, validate_id, Library};
use crate::error::{Error, Result};

pub const SAMPLES_DIR: &str = "samples";
pub const SAMPLE_FILE: &str = "sample.wav";
/// Settings are a few numbers; anything near this is not one.
const MAX_SETTINGS_BYTES: usize = 16 * 1024;
/// A sample is a short sound: at most this long (ms).
pub const MAX_SAMPLE_MS: i64 = 60_000;
/// Largest stored audio accepted (bytes): a minute of 48 kHz stereo 16-bit is about 11.5 MB.
const MAX_SAMPLE_BYTES: usize = 24 * 1024 * 1024;
const MAX_TITLE_CHARS: usize = 120;

fn settings_to_json(settings: Option<&serde_json::Value>) -> Result<String> {
    let Some(value) = settings else {
        return Ok("{}".into());
    };
    if !value.is_object() {
        return Err(Error::Invalid("sample settings must be an object".into()));
    }
    let json = serde_json::to_string(value)?;
    if json.len() > MAX_SETTINGS_BYTES {
        return Err(Error::Invalid("the sample settings are too large".into()));
    }
    Ok(json)
}

fn clean_title(title: &str) -> String {
    title.trim().chars().take(MAX_TITLE_CHARS).collect()
}

/// A WAV file (RIFF/WAVE header) of a reasonable size.
fn validate_wav(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(Error::Invalid("a sample must be a WAV file".into()));
    }
    if bytes.len() > MAX_SAMPLE_BYTES {
        return Err(Error::Invalid("the sample is too long".into()));
    }
    Ok(())
}

impl Library {
    pub fn samples_dir(&self) -> PathBuf {
        self.root().join(SAMPLES_DIR)
    }

    pub fn sample_dir(&self, id: &str) -> PathBuf {
        self.samples_dir().join(id)
    }

    fn row_to_sample(&self, row: &Row<'_>) -> rusqlite::Result<Sample> {
        let id: String = row.get("id")?;
        let file = self.sample_dir(&id).join(SAMPLE_FILE);
        let settings: String = row.get("settings_json")?;
        Ok(Sample {
            title: row.get("title")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            duration_ms: row.get("duration_ms")?,
            audio_path: file.is_file().then(|| file.display().to_string()),
            source_sketch_id: row.get("source_sketch_id")?,
            source_start_ms: row.get("source_start_ms")?,
            source_end_ms: row.get("source_end_ms")?,
            settings: serde_json::from_str(&settings).unwrap_or_else(|_| serde_json::json!({})),
            id,
        })
    }

    /// Every sample, oldest first (the order they appear in the library).
    pub fn list_samples(&self) -> Result<Vec<Sample>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM samples ORDER BY created_at, id")?;
        let rows = stmt.query_map([], |row| self.row_to_sample(row))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_sample(&self, id: &str) -> Result<Sample> {
        validate_id(id)?;
        self.conn()
            .query_row("SELECT * FROM samples WHERE id = ?1", [id], |row| self.row_to_sample(row))
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("sample {id}")))
    }

    /// A new sample (its folder made; the audio follows with `write_sample_audio`).
    pub fn create_sample(&self, args: CreateSampleArgs) -> Result<Sample> {
        if let Some(source) = &args.source_sketch_id {
            validate_id(source)?;
        }
        if let Some(ms) = args.duration_ms {
            if !(1..=MAX_SAMPLE_MS).contains(&ms) {
                return Err(Error::Invalid(format!("a sample of {ms} ms is out of range")));
            }
        }
        if let (Some(a), Some(b)) = (args.source_start_ms, args.source_end_ms) {
            if b <= a {
                return Err(Error::Invalid("a sample must end after it starts".into()));
            }
        }
        let settings = settings_to_json(args.settings.as_ref())?;
        let id = new_id();
        fs::create_dir_all(self.sample_dir(&id))?;
        let now = now_ms();
        let inserted = self.conn().execute(
            "INSERT INTO samples (id, title, created_at, updated_at, duration_ms, source_sketch_id,
                                  source_start_ms, source_end_ms, settings_json)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                clean_title(args.title.as_deref().unwrap_or_default()),
                now,
                args.duration_ms,
                args.source_sketch_id,
                args.source_start_ms,
                args.source_end_ms,
                settings,
            ],
        );
        if let Err(error) = inserted {
            let _ = fs::remove_dir_all(self.sample_dir(&id));
            return Err(error.into());
        }
        self.get_sample(&id)
    }

    /// Store a sample's audio (a WAV file). Written once: a sample's sound is
    /// changed by its settings, never by rewriting the audio.
    pub fn write_sample_audio(&self, id: &str, bytes: &[u8]) -> Result<PathBuf> {
        validate_id(id)?;
        validate_wav(bytes)?;
        let dir = self.sample_dir(id);
        if !dir.is_dir() {
            return Err(Error::NotFound(format!("sample {id}")));
        }
        let path = dir.join(SAMPLE_FILE);
        if path.exists() {
            return Err(Error::Invalid("the sample's audio is already saved".into()));
        }
        // Write-then-rename so readers never see a half-written file.
        let tmp = path.with_extension("partial");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        self.conn().execute("UPDATE samples SET updated_at = ?2 WHERE id = ?1", params![id, now_ms()])?;
        Ok(path)
    }

    /// Rename a sample or change its settings.
    pub fn update_sample(&self, args: UpdateSampleArgs) -> Result<Sample> {
        validate_id(&args.id)?;
        let settings = match &args.settings {
            Some(value) => Some(settings_to_json(Some(value))?),
            None => None,
        };
        let title = args.title.as_deref().map(clean_title);
        let changed = self.conn().execute(
            "UPDATE samples SET title = COALESCE(?2, title), settings_json = COALESCE(?3, settings_json),
                                updated_at = ?4
              WHERE id = ?1",
            params![args.id, title, settings, now_ms()],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(format!("sample {}", args.id)));
        }
        self.get_sample(&args.id)
    }

    /// Delete a sample and its audio. Sketches that played their notes with it go back to the piano.
    pub fn delete_sample(&self, id: &str) -> Result<()> {
        validate_id(id)?;
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            tx.execute("UPDATE sketches SET note_sample_id = NULL WHERE note_sample_id = ?1", [id])?;
            tx.execute("DELETE FROM samples WHERE id = ?1", [id])?;
            tx.commit()?;
        }
        let dir = self.sample_dir(id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Play a sketch's notes with a library sample (None: the built-in piano).
    pub fn set_note_sample(&self, id: &str, sample_id: Option<&str>) -> Result<Sketch> {
        validate_id(id)?;
        if let Some(sample) = sample_id {
            self.get_sample(sample)?;
        }
        let changed = self.conn().execute(
            "UPDATE sketches SET note_sample_id = ?2, updated_at = ?3 WHERE id = ?1 AND parent_id IS NULL",
            params![id, sample_id, now_ms()],
        )?;
        if changed == 0 {
            return Err(Error::NotFound(id.to_string()));
        }
        Ok(self.get(id)?.sketch)
    }
}
