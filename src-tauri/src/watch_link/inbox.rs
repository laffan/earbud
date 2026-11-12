//! Received recordings waiting to be imported.
//!
//! Every transport writes into the same folder (`library/inbox/`): the
//! local-network server in Rust, and the Bluetooth and WatchConnectivity
//! receivers in Swift (`plugins/tauri-plugin-watch-link`). An entry is two
//! files:
//!
//! ```text
//! <sketch id>.m4a    the audio, exactly as the Watch recorded it
//! <sketch id>.json   InboxEntry, written last (its presence means "complete")
//! ```
//!
//! Partial files start with a dot and are ignored. Importing moves the audio
//! into a new sketch folder and removes the sidecar, so an entry is imported
//! at most once, and one delivered twice (the Watch resends when an
//! acknowledgement is lost) becomes a single sketch.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::protocol::{format_iso8601, sketch_id_for, valid_extension, RecordingTransfer};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    /// The Watch's recording id (UUID string).
    pub id: String,
    pub name: String,
    /// ISO-8601, when the recording started.
    pub created_at: String,
    /// Seconds.
    pub duration: f64,
    /// Name of the audio file in the inbox folder.
    pub file_name: String,
    pub mime_type: String,
    pub byte_count: u64,
    /// `localNetwork`, `bluetooth` or `phoneSession`.
    pub received_via: String,
    #[serde(default)]
    pub sender: Option<String>,
    #[serde(default)]
    pub received_at: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum InboxError {
    #[error("invalid recording: {0}")]
    Invalid(String),
    #[error("the recording was cut off ({received} of {expected} bytes)")]
    Truncated { received: u64, expected: u64 },
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stream a recording's audio from `body` into the inbox and write its
/// sidecar. Fails (leaving nothing behind) unless exactly
/// `transfer.byte_count` bytes arrive.
pub fn receive(
    dir: &Path,
    transfer: &RecordingTransfer,
    via: &str,
    body: impl Read,
) -> Result<InboxEntry, InboxError> {
    let recording = &transfer.recording;
    let stem = sketch_id_for(&recording.id)
        .ok_or_else(|| InboxError::Invalid(format!("recording id '{}' is not a UUID", recording.id)))?;
    let ext = recording.file_extension.to_ascii_lowercase();
    if !valid_extension(&ext) {
        return Err(InboxError::Invalid(format!("file extension '{ext}'")));
    }
    if transfer.byte_count == 0 {
        return Err(InboxError::Invalid("empty recording".into()));
    }
    fs::create_dir_all(dir)?;
    let file_name = format!("{stem}.{ext}");
    let part = dir.join(format!(".{file_name}.part"));
    let received = {
        let mut file = File::create(&part)?;
        let copied = io::copy(&mut body.take(transfer.byte_count), &mut file);
        let copied = match copied {
            Ok(n) => n,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&part);
                return Err(error.into());
            }
        };
        file.sync_all()?;
        copied
    };
    if received != transfer.byte_count {
        let _ = fs::remove_file(&part);
        return Err(InboxError::Truncated {
            received,
            expected: transfer.byte_count,
        });
    }
    fs::rename(&part, dir.join(&file_name))?;
    let entry = InboxEntry {
        id: recording.id.clone(),
        name: recording.name.clone(),
        created_at: recording.created_at.clone(),
        duration: recording.duration,
        file_name,
        mime_type: recording.mime_type.clone(),
        byte_count: received,
        received_via: via.to_string(),
        sender: transfer.sender_name.clone(),
        received_at: Some(format_iso8601(now_ms())),
    };
    write_sidecar(dir, &stem, &entry)?;
    Ok(entry)
}

fn write_sidecar(dir: &Path, stem: &str, entry: &InboxEntry) -> Result<(), InboxError> {
    let tmp = dir.join(format!(".{stem}.json.part"));
    {
        let mut file = File::create(&tmp)?;
        file.write_all(&serde_json::to_vec_pretty(entry)?)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, dir.join(format!("{stem}.json")))?;
    Ok(())
}

/// A complete entry found in the inbox.
#[derive(Debug, Clone)]
pub struct Pending {
    pub sidecar: PathBuf,
    pub audio: PathBuf,
    pub entry: InboxEntry,
}

/// Entries ready to import, oldest recording first. Unreadable sidecars are
/// renamed to `*.json.bad` and reported in the second list.
pub fn pending(dir: &Path) -> io::Result<(Vec<Pending>, Vec<String>)> {
    let mut found = vec![];
    let mut bad = vec![];
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((found, bad)),
        Err(e) => return Err(e),
    };
    for item in entries {
        let path = item?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let parsed = fs::read(&path)
            .map_err(InboxError::from)
            .and_then(|bytes| Ok(serde_json::from_slice::<InboxEntry>(&bytes)?))
            .and_then(|entry| {
                let plain = !entry.file_name.is_empty()
                    && !entry.file_name.starts_with('.')
                    && !entry.file_name.contains(&['/', '\\'][..]);
                if plain {
                    Ok(entry)
                } else {
                    Err(InboxError::Invalid(format!("file name '{}'", entry.file_name)))
                }
            });
        match parsed {
            Ok(entry) => {
                let audio = dir.join(&entry.file_name);
                found.push(Pending {
                    sidecar: path,
                    audio,
                    entry,
                });
            }
            Err(error) => {
                bad.push(format!("{name}: {error}"));
                set_aside(&path);
            }
        }
    }
    found.sort_by(|a, b| a.entry.created_at.cmp(&b.entry.created_at));
    Ok((found, bad))
}

/// Keep a sidecar that cannot be imported for inspection, without retrying it
/// on every launch.
pub fn set_aside(sidecar: &Path) {
    let mut bad = sidecar.as_os_str().to_owned();
    bad.push(".bad");
    let _ = fs::rename(sidecar, PathBuf::from(bad));
}
