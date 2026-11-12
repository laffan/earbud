use super::inbox::{self, InboxEntry};
use super::protocol::*;
use super::*;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::time::Duration;

use tempfile::TempDir;

/// Fixtures shared with the Swift package's tests: what the Watch and the
/// iOS receivers actually put on the wire and in the inbox.
const FIXTURE_TRANSFER: &str =
    include_str!("../../../watch-app/Packages/EarbudLink/Tests/EarbudLinkTests/Fixtures/recording-transfer.json");
const FIXTURE_INBOX_ENTRY: &str =
    include_str!("../../../watch-app/Packages/EarbudLink/Tests/EarbudLinkTests/Fixtures/inbox-entry.json");
const FIXTURE_PAIRING_RESPONSE: &str =
    include_str!("../../../watch-app/Packages/EarbudLink/Tests/EarbudLinkTests/Fixtures/pairing-response.json");

// ------------------------------------------------------------------ protocol

#[test]
fn parses_iso8601_timestamps() {
    assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(parse_iso8601_ms("2026-11-11T18:04:05Z"), Some(1_794_420_245_000));
    assert_eq!(parse_iso8601_ms("2026-11-11T18:04:05.25Z"), Some(1_794_420_245_250));
    assert_eq!(parse_iso8601_ms("2026-11-11T10:04:05-08:00"), Some(1_794_420_245_000));
    assert_eq!(parse_iso8601_ms("2026-11-12T03:34:05+09:30"), Some(1_794_420_245_000));
    assert_eq!(parse_iso8601_ms("2024-02-29T12:00:00Z"), Some(1_709_208_000_000));
    assert_eq!(parse_iso8601_ms("2026-11-11"), None);
    assert_eq!(parse_iso8601_ms("2026-13-11T00:00:00Z"), None);
    assert_eq!(parse_iso8601_ms("2026-11-11T18:04:05Zjunk"), None);
    assert_eq!(parse_iso8601_ms("not a date at all!!"), None);
}

#[test]
fn formats_iso8601_round_trip() {
    for ms in [0, 1_709_208_000_000, 1_794_420_245_000, 951_782_400_000] {
        assert_eq!(parse_iso8601_ms(&format_iso8601(ms)), Some(ms));
    }
    assert_eq!(format_iso8601(1_794_420_245_000), "2026-11-11T18:04:05Z");
}

#[test]
fn sketch_ids_come_from_uuids() {
    assert_eq!(
        sketch_id_for("E621E1F8-C36C-495A-93FC-0C247A3E6E5F").as_deref(),
        Some("e621e1f8c36c495a93fc0c247a3e6e5f")
    );
    assert_eq!(
        sketch_id_for("e621e1f8c36c495a93fc0c247a3e6e5f").as_deref(),
        Some("e621e1f8c36c495a93fc0c247a3e6e5f")
    );
    assert_eq!(sketch_id_for("../../etc/passwd"), None);
    assert_eq!(sketch_id_for("E621E1F8-C36C-495A-93FC-0C247A3E6E5"), None);
    assert_eq!(sketch_id_for("E621-E1F8-C36C-495A-93FC-0C247A3E6E5F"), None);
}

#[test]
fn compares_secrets() {
    assert!(secrets_match("abc", Some("abc")));
    assert!(!secrets_match("abc", Some("abd")));
    assert!(!secrets_match("abc", Some("ab")));
    assert!(!secrets_match("abc", None));
    assert!(!secrets_match("", Some("")));
}

#[test]
fn decodes_the_swift_fixtures() {
    let transfer: RecordingTransfer = serde_json::from_str(FIXTURE_TRANSFER).unwrap();
    assert_eq!(transfer.byte_count, 48_213);
    assert_eq!(transfer.recording.mime_type, "audio/mp4");
    assert_eq!(transfer.recording.duration, 12.5);
    assert_eq!(transfer.sender_name.as_deref(), Some("Apple Watch"));
    assert_eq!(parse_iso8601_ms(&transfer.recording.created_at), Some(1_794_420_245_000));

    let entry: InboxEntry = serde_json::from_str(FIXTURE_INBOX_ENTRY).unwrap();
    assert_eq!(entry.received_via, "bluetooth");
    assert_eq!(entry.file_name, "e621e1f8c36c495a93fc0c247a3e6e5f.m4a");

    // What this server sends must decode as the Swift fixture does.
    let response: PairingResponse = serde_json::from_str(FIXTURE_PAIRING_RESPONSE).unwrap();
    let ours = serde_json::to_value(&response).unwrap();
    let theirs: serde_json::Value = serde_json::from_str(FIXTURE_PAIRING_RESPONSE).unwrap();
    assert_eq!(ours, theirs);
}

// --------------------------------------------------------------------- inbox

fn transfer(id: &str, bytes: u64) -> RecordingTransfer {
    RecordingTransfer {
        recording: TransferRecording {
            id: id.into(),
            name: "Nov 11, 10:04 AM".into(),
            created_at: "2026-11-11T18:04:05Z".into(),
            duration: 12.5,
            file_extension: "m4a".into(),
            mime_type: "audio/mp4".into(),
        },
        byte_count: bytes,
        pairing_secret: None,
        sender_name: Some("Test Watch".into()),
    }
}

const ID: &str = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
const SKETCH_ID: &str = "e621e1f8c36c495a93fc0c247a3e6e5f";

#[test]
fn inbox_receives_complete_recordings_only() {
    let dir = TempDir::new().unwrap();
    let inbox_dir = dir.path().join("inbox");
    let audio = vec![7u8; 1000];

    let entry = inbox::receive(&inbox_dir, &transfer(ID, 1000), "localNetwork", &audio[..]).unwrap();
    assert_eq!(entry.file_name, format!("{SKETCH_ID}.m4a"));
    assert_eq!(std::fs::read(inbox_dir.join(&entry.file_name)).unwrap(), audio);
    let (pending, bad) = inbox::pending(&inbox_dir).unwrap();
    assert_eq!(pending.len(), 1);
    assert!(bad.is_empty());
    assert_eq!(pending[0].entry, entry);

    let other = "0B5D1A2C-3E4F-4A6B-8C9D-0E1F2A3B4C5D";
    let short = inbox::receive(&inbox_dir, &transfer(other, 1000), "localNetwork", &audio[..400]);
    assert!(matches!(short, Err(inbox::InboxError::Truncated { received: 400, expected: 1000 })));
    let names: Vec<_> = std::fs::read_dir(&inbox_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names.len(), 2, "only the first entry remains: {names:?}");

    let bad_id = inbox::receive(&inbox_dir, &transfer("../escape", 10), "localNetwork", &audio[..10]);
    assert!(matches!(bad_id, Err(inbox::InboxError::Invalid(_))));
}

#[test]
fn unreadable_sidecars_are_set_aside() {
    let dir = TempDir::new().unwrap();
    std::fs::write(dir.path().join("broken.json"), b"{ nope").unwrap();
    std::fs::write(dir.path().join("sneaky.json"), FIXTURE_INBOX_ENTRY.replace("e621e1f8c36c495a93fc0c247a3e6e5f.m4a", "../x.m4a")).unwrap();
    std::fs::write(dir.path().join(".partial.json.part"), b"{}").unwrap();
    let (pending, bad) = inbox::pending(dir.path()).unwrap();
    assert!(pending.is_empty());
    assert_eq!(bad.len(), 2);
    assert!(dir.path().join("broken.json.bad").exists());
    assert!(dir.path().join("sneaky.json.bad").exists());
}

fn events() -> (EventSink, mpsc::Receiver<WatchLinkEvent>) {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    (
        Box::new(move |event| {
            let _ = lock(&tx).send(event);
        }),
        rx,
    )
}

fn open(dir: &TempDir) -> (Library, WatchLink, mpsc::Receiver<WatchLinkEvent>) {
    let root = dir.path().join("library");
    let library = Library::open(&root).unwrap();
    let (sink, rx) = events();
    let watch = WatchLink::open(&root, 0, sink).unwrap();
    (library, watch, rx)
}

#[test]
fn imports_inbox_entries_once() {
    let dir = TempDir::new().unwrap();
    let (library, watch, _events) = open(&dir);
    let audio = vec![1u8; 2048];
    inbox::receive(watch.inbox_dir(), &transfer(ID, 2048), "bluetooth", &audio[..]).unwrap();

    let report = watch.import_inbox(&library).unwrap();
    assert_eq!(report.imported.len(), 1);
    let sketch = &report.imported[0];
    assert_eq!(sketch.id, SKETCH_ID);
    assert_eq!(sketch.created_at, 1_794_420_245_000);
    assert_eq!(sketch.duration_ms, Some(12_500));
    assert_eq!(sketch.capture_backend, WATCH_BACKEND);
    assert!(!sketch.has_video);
    assert_eq!(sketch.media_mime.as_deref(), Some("audio/mp4"));
    let media = sketch.media_path.as_ref().unwrap();
    assert!(media.ends_with("recording.m4a"));
    assert_eq!(std::fs::read(media).unwrap(), audio);
    assert!(inbox::pending(watch.inbox_dir()).unwrap().0.is_empty());

    // The Watch resends when it misses the acknowledgement.
    inbox::receive(watch.inbox_dir(), &transfer(ID, 2048), "localNetwork", &audio[..]).unwrap();
    let again = watch.import_inbox(&library).unwrap();
    assert!(again.imported.is_empty());
    assert_eq!(again.duplicates, 1);
    assert_eq!(library.list().unwrap().len(), 1);
    assert_eq!(std::fs::read_dir(watch.inbox_dir()).unwrap().count(), 0);
}

#[test]
fn identity_persists_and_reset_changes_the_secret() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("library");
    let (sink, _rx) = events();
    let first = WatchLink::open(&root, 0, sink).unwrap();
    let before = first.status();
    first.set_display_name("  Studio iPhone  ").unwrap();
    drop(first);

    let (sink, _rx) = events();
    let second = WatchLink::open(&root, 0, sink).unwrap();
    let after = second.status();
    assert_eq!(after.device_id, before.device_id);
    assert_eq!(after.secret, before.secret);
    assert_eq!(after.display_name, "Studio iPhone");
    assert!(!after.name_is_default);
    assert!(!after.enabled);

    let reset = second.reset_pairing().unwrap();
    assert_ne!(reset.secret, before.secret);
    assert_eq!(reset.device_id, before.device_id);
    assert_eq!(second.set_display_name("").unwrap().display_name, default_display_name());
}

// -------------------------------------------------------------------- server

fn connect(port: u16) -> TcpStream {
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream
}

fn pair(port: u16, code: &str) -> Option<PairingResponse> {
    let mut stream = connect(port);
    let request = serde_json::to_vec(&PairingRequest {
        code: code.into(),
        device_name: "Test Watch".into(),
    })
    .unwrap();
    let mut frame = vec![MSG_PAIRING];
    frame.extend(length_prefixed(&request));
    stream.write_all(&frame).unwrap();
    let mut ack = [0u8; 1];
    stream.read_exact(&mut ack).unwrap();
    if ack[0] != 1 {
        return None;
    }
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
    stream.read_exact(&mut body).unwrap();
    Some(serde_json::from_slice(&body).unwrap())
}

/// Send a recording the way the Watch's `LocalNetworkClient` does. Returns
/// the acknowledgement byte, or `None` if the server closed without one.
fn send_recording(port: u16, transfer: &RecordingTransfer, audio: &[u8]) -> Option<u8> {
    let mut stream = connect(port);
    let header = serde_json::to_vec(transfer).unwrap();
    let mut frame = vec![MSG_RECORDING];
    frame.extend(length_prefixed(&header));
    frame.extend_from_slice(audio);
    // The server may refuse before reading the audio, so a write can fail.
    let _ = stream.write_all(&frame);
    let mut ack = [0u8; 1];
    stream.read_exact(&mut ack).ok().map(|_| ack[0])
}

fn next_event(rx: &mpsc::Receiver<WatchLinkEvent>) -> WatchLinkEvent {
    rx.recv_timeout(Duration::from_secs(5)).expect("no event")
}

#[test]
fn pairs_and_receives_over_tcp() {
    let dir = TempDir::new().unwrap();
    let (library, watch, events) = open(&dir);
    watch.set_display_name("Studio iPhone").unwrap();

    // Off: nothing listens.
    assert!(!watch.status().listening);

    let status = watch.begin_pairing().unwrap();
    assert!(status.enabled && status.listening, "{status:?}");
    let port = status.port;
    assert_ne!(port, 0);
    let code = status.pairing.as_ref().unwrap().code.clone();
    assert_eq!(code.len(), 5);

    let wrong = if code == "00000" { "11111" } else { "00000" };
    assert!(pair(port, wrong).is_none());

    let response = pair(port, &code).expect("pairing refused");
    assert_eq!(response.display_name, "Studio iPhone");
    assert_eq!(response.token, status.secret);
    assert_eq!(response.device_id, status.device_id);
    assert_eq!(response.port, port);
    match next_event(&events) {
        WatchLinkEvent::Paired { watch_name, via } => {
            assert_eq!(watch_name, "Test Watch");
            assert_eq!(via, VIA_LOCAL_NETWORK);
        }
        other => panic!("unexpected {other:?}"),
    }
    let status = watch.status();
    assert!(status.pairing.is_none(), "the window closes after pairing");
    assert_eq!(status.paired_watches.len(), 1);
    // The same code does not work twice.
    assert!(pair(port, &code).is_none());

    // A recording without the secret is refused and leaves nothing behind.
    let audio: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
    let mut unsigned = transfer(ID, audio.len() as u64);
    assert_eq!(send_recording(port, &unsigned, &audio), Some(0));
    assert!(matches!(next_event(&events), WatchLinkEvent::Error { .. }));
    assert!(inbox::pending(watch.inbox_dir()).unwrap().0.is_empty());

    // With the secret it is accepted, stored intact and importable.
    unsigned.pairing_secret = Some(response.token.clone());
    assert_eq!(send_recording(port, &unsigned, &audio), Some(1));
    match next_event(&events) {
        WatchLinkEvent::Received { name, sender, via } => {
            assert_eq!(name, "Nov 11, 10:04 AM");
            assert_eq!(sender.as_deref(), Some("Test Watch"));
            assert_eq!(via, VIA_LOCAL_NETWORK);
        }
        other => panic!("unexpected {other:?}"),
    }
    let report = watch.import_inbox(&library).unwrap();
    assert_eq!(report.imported.len(), 1);
    assert_eq!(std::fs::read(report.imported[0].media_path.as_ref().unwrap()).unwrap(), audio);

    // A connection that drops mid-upload stores nothing.
    let other = transfer("0B5D1A2C-3E4F-4A6B-8C9D-0E1F2A3B4C5D", audio.len() as u64);
    let mut signed = other.clone();
    signed.pairing_secret = Some(response.token.clone());
    {
        let mut stream = connect(port);
        let header = serde_json::to_vec(&signed).unwrap();
        let mut frame = vec![MSG_RECORDING];
        frame.extend(length_prefixed(&header));
        frame.extend_from_slice(&audio[..1000]);
        stream.write_all(&frame).unwrap();
    }
    assert!(matches!(next_event(&events), WatchLinkEvent::Error { .. }));
    assert!(inbox::pending(watch.inbox_dir()).unwrap().0.is_empty());

    // After a reset the old secret no longer works.
    watch.reset_pairing().unwrap();
    assert_eq!(send_recording(port, &signed, &audio), Some(0));

    // Turning receiving off stops the server.
    assert!(!watch.set_enabled(false).unwrap().listening);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
}

#[test]
fn too_many_wrong_codes_close_the_window() {
    let dir = TempDir::new().unwrap();
    let (_library, watch, _events) = open(&dir);
    let status = watch.begin_pairing().unwrap();
    let code = status.pairing.unwrap().code;
    let wrong = if code == "99999" { "88888" } else { "99999" };
    for _ in 0..20 {
        assert!(pair(status.port, wrong).is_none());
    }
    assert!(watch.status().pairing.is_none());
    assert!(pair(status.port, &code).is_none());
}

#[test]
fn ignores_garbage() {
    let dir = TempDir::new().unwrap();
    let (_library, watch, _events) = open(&dir);
    let port = watch.set_enabled(true).unwrap().port;
    for junk in [&b"\x07hello"[..], &b"\x01\xff\xff\xff\xff"[..], &b"\x02\x00\x00\x00\x03{x}"[..]] {
        let mut stream = connect(port);
        stream.write_all(junk).unwrap();
        let mut buf = [0u8; 8];
        let n = stream.read(&mut buf).unwrap_or(0);
        assert!(n <= 1 && (n == 0 || buf[0] == 0), "{junk:?} → {:?}", &buf[..n]);
    }
    // Still serving.
    assert!(watch.status().listening);
}
