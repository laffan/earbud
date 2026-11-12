//! Wire format shared with the Apple Watch app (`watch-app/Packages/EarbudLink`).
//!
//! This is the Woods Whisper local-network protocol with Earbud's own port
//! and payload. Every TCP connection carries one message, starting with a
//! one-byte type:
//!
//! ```text
//! recording (0x01): [0x01][u32 BE headerLen][RecordingTransfer JSON][audio bytes]
//!                   → reply [1 byte: 1 accepted, 0 rejected]
//! pairing   (0x02): [0x02][u32 BE requestLen][PairingRequest JSON]
//!                   → reply [1 byte ack] and, if accepted, [u32 BE len][PairingResponse JSON]
//! ```
//!
//! JSON is produced by Swift's `JSONEncoder` with ISO-8601 dates, so dates
//! arrive as strings like `2026-11-11T10:15:30Z`.

use serde::{Deserialize, Serialize};

/// Fixed TCP port. The Watch cannot browse Bonjour, so it finds the receiver
/// by trying this port on every host of its subnet while pairing.
/// (Woods Whisper uses 50710; a different port keeps the two apps apart.)
pub const DEFAULT_PORT: u16 = 50720;

pub const MSG_RECORDING: u8 = 0x01;
pub const MSG_PAIRING: u8 = 0x02;

pub const MAX_HEADER_BYTES: u32 = 64 * 1024;
pub const MAX_PAIRING_BYTES: u32 = 4 * 1024;
/// About 9 hours of the Watch's high-quality setting (128 kbit/s AAC).
pub const MAX_AUDIO_BYTES: u64 = 512 * 1024 * 1024;

/// Metadata of one recording, as the Watch describes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecording {
    /// UUID string, e.g. `E621E1F8-C36C-495A-93FC-0C247A3E6E5F`.
    pub id: String,
    pub name: String,
    /// ISO-8601, when the recording started.
    pub created_at: String,
    /// Seconds.
    pub duration: f64,
    /// `m4a`
    pub file_extension: String,
    /// `audio/mp4`
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTransfer {
    pub recording: TransferRecording,
    pub byte_count: u64,
    /// The secret handed out at pairing. Required on the local network.
    #[serde(default)]
    pub pairing_secret: Option<String>,
    /// The Watch's name, for "received from …".
    #[serde(default)]
    pub sender_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub code: String,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingResponse {
    /// The name the Watch shows as the destination of its recordings.
    pub display_name: String,
    /// Durable secret the Watch stamps on every transfer.
    pub token: String,
    pub port: u16,
    /// Stable id of this receiver, so the Watch can recognise it on every
    /// transport (local network, Bluetooth, paired iPhone).
    pub device_id: String,
}

/// `[u32 BE length][payload]`
pub fn length_prefixed(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// The sketch id for a recording id: the UUID's 32 hex digits, lower case.
/// Returns `None` for anything that is not a UUID.
pub fn sketch_id_for(recording_id: &str) -> Option<String> {
    let hex: String = recording_id.chars().filter(|c| *c != '-').collect();
    let dashes = recording_id.len() - hex.len();
    if hex.len() == 32 && (dashes == 0 || dashes == 4) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

/// `m4a`, `wav`, … (1–5 ASCII letters or digits).
pub fn valid_extension(ext: &str) -> bool {
    (1..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Parse an ISO-8601 / RFC 3339 timestamp into milliseconds since the Unix
/// epoch: `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]`.
pub fn parse_iso8601_ms(value: &str) -> Option<i64> {
    let b = value.trim().as_bytes();
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        let s = std::str::from_utf8(b.get(range)?).ok()?;
        if s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse().ok()
        } else {
            None
        }
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        let digits = &value.trim()[start..i];
        let first3: String = digits.chars().chain("000".chars()).take(3).collect();
        millis = first3.parse().ok()?;
    }
    let offset_minutes = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(&sign @ (b'+' | b'-')) if b.len() == i + 6 && b[i + 3] == b':' => {
            let h = num(i + 1..i + 3)?;
            let m = num(i + 4..i + 6)?;
            let total = h * 60 + m;
            if sign == b'+' {
                total
            } else {
                -total
            }
        }
        None => 0, // no zone: treat as UTC
        _ => return None,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Format milliseconds since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (UTC).
pub fn format_iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60
    )
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Compare secrets without an early exit on the first differing byte.
pub fn secrets_match(expected: &str, presented: Option<&str>) -> bool {
    let Some(presented) = presented else { return false };
    let (a, b) = (expected.as_bytes(), presented.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
