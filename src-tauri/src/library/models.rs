//! Data types shared between the sketch library and the frontend.
//!
//! Everything is serialized in camelCase so it maps 1:1 onto the TypeScript
//! types in `src/lib/library/types.ts`.

use serde::{Deserialize, Serialize};

/// Lifecycle of the *recording* itself. A sketch row is created before the
/// capture engine starts writing, so an interrupted recording can be found
/// and recovered on the next launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SketchStatus {
    /// The capture engine is (or was, if the app died) writing the media file.
    Recording,
    /// The media file is complete and is the immutable source of truth.
    Saved,
}

impl SketchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SketchStatus::Recording => "recording",
            SketchStatus::Saved => "saved",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "recording" => SketchStatus::Recording,
            _ => SketchStatus::Saved,
        }
    }
}

/// Lifecycle of the *derived* transcription. Independent of [`SketchStatus`]:
/// a sketch is complete and playable no matter what happens here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptionStatus {
    Pending,
    Running,
    Done,
    Failed,
}

impl TranscriptionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TranscriptionStatus::Pending => "pending",
            TranscriptionStatus::Running => "running",
            TranscriptionStatus::Done => "done",
            TranscriptionStatus::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "running" => TranscriptionStatus::Running,
            "done" => TranscriptionStatus::Done,
            "failed" => TranscriptionStatus::Failed,
            _ => TranscriptionStatus::Pending,
        }
    }
}

/// One detected or user-edited note. Mirrors the `PianoNote` interface of the
/// transcription engine contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PianoNote {
    /// MIDI note number (21 = A0 … 108 = C8 on a piano).
    pub pitch: u8,
    /// Seconds from the start of the recording.
    pub start_time: f64,
    pub end_time: f64,
    /// MIDI velocity, 0–127.
    pub velocity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

impl PianoNote {
    pub fn validate(&self) -> Result<(), String> {
        if self.pitch > 127 {
            return Err(format!("pitch {} out of MIDI range", self.pitch));
        }
        if !self.start_time.is_finite() || !self.end_time.is_finite() {
            return Err("note times must be finite".into());
        }
        if self.start_time < 0.0 || self.end_time <= self.start_time {
            return Err(format!(
                "invalid note span {}..{}",
                self.start_time, self.end_time
            ));
        }
        if !self.velocity.is_finite() || !(0.0..=127.0).contains(&self.velocity) {
            return Err(format!("velocity {} out of range", self.velocity));
        }
        if let Some(c) = self.confidence {
            if !c.is_finite() {
                return Err("confidence must be finite".into());
            }
        }
        Ok(())
    }
}

/// A sketch as shown in the library list and the detail view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sketch {
    pub id: String,
    pub title: String,
    /// Unix epoch milliseconds.
    pub created_at: i64,
    pub updated_at: i64,
    pub status: SketchStatus,
    pub duration_ms: Option<i64>,
    /// Absolute path of the original recording (source of truth, never modified).
    pub media_path: Option<String>,
    pub media_mime: Option<String>,
    pub has_video: bool,
    pub video_width: Option<i64>,
    pub video_height: Option<i64>,
    /// Absolute path of the derived 22.05 kHz mono WAV used for analysis.
    pub analysis_path: Option<String>,
    pub text_notes: String,
    pub transcription_status: TranscriptionStatus,
    pub transcription_error: Option<String>,
    pub capture_backend: String,
    /// True when the recording was interrupted (app killed, crash) and
    /// recovered on a later launch.
    pub recovered: bool,
    /// Small precomputed summary (note count, chord names, preview notes)
    /// produced by the music engine so the list does not need every note.
    pub summary: Option<serde_json::Value>,
    pub has_edits: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub engine: String,
    pub engine_version: String,
    pub params: serde_json::Value,
    /// Raw engine output. Kept forever so edits can always be reverted.
    pub original_notes: Vec<PianoNote>,
    /// User-corrected notes; `None` until the first edit.
    pub edited_notes: Option<Vec<PianoNote>>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SketchDetail {
    #[serde(flatten)]
    pub sketch: Sketch,
    pub transcription: Option<Transcription>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSketchArgs {
    /// File extension of the media the capture backend will write, e.g. `mov`.
    pub media_extension: String,
    pub media_mime: String,
    pub capture_backend: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSketch {
    pub id: String,
    pub dir: String,
    pub media_path: String,
    pub analysis_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeSketchArgs {
    pub id: String,
    pub duration_ms: Option<i64>,
    pub has_video: bool,
    pub video_width: Option<i64>,
    pub video_height: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSketchArgs {
    pub id: String,
    pub title: Option<String>,
    pub text_notes: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTranscriptionArgs {
    pub id: String,
    pub engine: String,
    pub engine_version: String,
    pub params: serde_json::Value,
    pub notes: Vec<PianoNote>,
    pub summary: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveEditsArgs {
    pub id: String,
    pub notes: Vec<PianoNote>,
    pub summary: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// Interrupted recordings whose media file survived and were kept.
    pub recovered: Vec<String>,
    /// Interrupted recordings with no usable media; removed.
    pub discarded: Vec<String>,
    /// Transcriptions that were running when the app stopped; reset to pending.
    pub requeued: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub root: String,
    pub sketches_dir: String,
    pub database_path: String,
}

/// What the user can choose to export from a sketch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExportKind {
    /// The original recording (video, or audio-only take), untouched.
    Recording,
    /// The take's audio track on its own.
    Audio,
    /// The transcribed notes rendered with the built-in synth.
    NotesAudio,
    /// The transcribed notes as a Standard MIDI File.
    Midi,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    pub kind: ExportKind,
    /// Friendly-named hard link (or copy) inside the sketch's exports folder.
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub files: Vec<ExportedFile>,
    /// Requested kinds that had no source file (e.g. no transcription yet).
    pub missing: Vec<ExportKind>,
}
