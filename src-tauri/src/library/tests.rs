use super::*;
use tempfile::TempDir;

fn lib() -> (TempDir, Library) {
    let dir = TempDir::new().unwrap();
    let lib = Library::open(dir.path().join("library")).unwrap();
    (dir, lib)
}

fn create(lib: &Library) -> CreatedSketch {
    lib.create_sketch(CreateSketchArgs {
        media_extension: "mov".into(),
        media_mime: "video/quicktime".into(),
        capture_backend: "test".into(),
        title: None,
        parent_id: None,
        track_id: None,
    })
    .unwrap()
}

/// Reserve a take for `parent`: on `track`, or on a new track.
fn create_take(lib: &Library, parent: &str, track: Option<&str>) -> CreatedSketch {
    lib.create_sketch(CreateSketchArgs {
        media_extension: "mov".into(),
        media_mime: "video/quicktime".into(),
        capture_backend: "test".into(),
        title: None,
        parent_id: Some(parent.into()),
        track_id: track.map(String::from),
    })
    .unwrap()
}

fn finalize_take(lib: &Library, created: &CreatedSketch, offset_ms: i64) -> Sketch {
    fs::write(&created.media_path, b"take").unwrap();
    lib.finalize_sketch(FinalizeSketchArgs {
        id: created.id.clone(),
        duration_ms: Some(8_000),
        has_video: false,
        video_width: None,
        video_height: None,
        offset_ms: Some(offset_ms),
        count_in_ms: Some(2_000),
    })
    .unwrap()
}

fn note(pitch: u8, start: f64, end: f64) -> PianoNote {
    PianoNote {
        pitch,
        start_time: start,
        end_time: end,
        velocity: 80.0,
        confidence: Some(0.9),
    }
}

fn finalize(lib: &Library, id: &str) -> Sketch {
    lib.finalize_sketch(FinalizeSketchArgs {
        id: id.into(),
        duration_ms: Some(12_000),
        has_video: true,
        video_width: Some(1280),
        video_height: Some(720),
        offset_ms: None,
        count_in_ms: None,
    })
    .unwrap()
}

#[test]
fn record_and_finalize_roundtrip() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    assert!(created.media_path.ends_with("recording.mov"));

    // Recording in progress is listed with its status.
    let listed = lib.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, SketchStatus::Recording);

    // Empty media cannot be finalized.
    assert!(lib
        .finalize_sketch(FinalizeSketchArgs {
            id: created.id.clone(),
            duration_ms: None,
            has_video: true,
            video_width: None,
            video_height: None,
            offset_ms: None,
            count_in_ms: None,
        })
        .is_err());

    fs::write(&created.media_path, b"fake movie").unwrap();
    let sketch = finalize(&lib, &created.id);
    assert_eq!(sketch.status, SketchStatus::Saved);
    assert_eq!(sketch.duration_ms, Some(12_000));
    assert_eq!(sketch.transcription_status, TranscriptionStatus::Pending);
    assert!(sketch.analysis_path.is_none());
}

#[test]
fn media_is_immutable_after_save() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    lib.write_file(&created.id, FileKind::MediaChunk, b"chunk-1").unwrap();
    lib.write_file(&created.id, FileKind::MediaChunk, b"chunk-2").unwrap();
    assert_eq!(fs::read(&created.media_path).unwrap(), b"chunk-1chunk-2");
    finalize(&lib, &created.id);
    assert!(lib.write_file(&created.id, FileKind::MediaChunk, b"x").is_err());
    assert_eq!(fs::read(&created.media_path).unwrap(), b"chunk-1chunk-2");
    // Saved sketches cannot be "discarded".
    assert!(lib.discard_sketch(&created.id).is_err());
}

#[test]
fn transcription_edits_are_non_destructive() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"fake").unwrap();
    finalize(&lib, &created.id);

    let original = vec![note(60, 0.5, 1.5), note(64, 0.5, 1.5), note(67, 0.5, 1.5)];
    let detail = lib
        .save_transcription(SaveTranscriptionArgs {
            id: created.id.clone(),
            engine: "basic-pitch".into(),
            engine_version: "1.0.1".into(),
            params: serde_json::json!({"onsetThreshold": 0.5}),
            notes: original.clone(),
            summary: Some(serde_json::json!({"noteCount": 3, "chords": ["C"]})),
        })
        .unwrap();
    assert_eq!(detail.sketch.transcription_status, TranscriptionStatus::Done);
    assert!(!detail.sketch.has_edits);

    let edited = vec![note(60, 0.5, 1.5), note(63, 0.5, 1.5), note(67, 0.5, 1.5)];
    let detail = lib
        .save_edits(SaveEditsArgs {
            id: created.id.clone(),
            notes: edited.clone(),
            summary: Some(serde_json::json!({"noteCount": 3, "chords": ["Cm"]})),
        })
        .unwrap();
    let t = detail.transcription.unwrap();
    assert_eq!(t.original_notes, original);
    assert_eq!(t.edited_notes.as_ref(), Some(&edited));
    assert!(detail.sketch.has_edits);
    assert_eq!(detail.sketch.summary.unwrap()["chords"][0], "Cm");

    let detail = lib.reset_edits(&created.id, None).unwrap();
    let t = detail.transcription.unwrap();
    assert!(t.edited_notes.is_none());
    assert_eq!(t.original_notes, original);
}

#[test]
fn rejects_invalid_notes_and_ids() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    let bad = SaveTranscriptionArgs {
        id: created.id.clone(),
        engine: "x".into(),
        engine_version: "0".into(),
        params: serde_json::json!({}),
        notes: vec![note(60, 1.0, 0.5)],
        summary: None,
    };
    assert!(lib.save_transcription(bad).is_err());
    assert!(lib.get("../../etc").is_err());
    assert!(lib.write_file("../x", FileKind::Analysis, b"").is_err());
}

#[test]
fn recovery_keeps_written_media_and_requeues() {
    let (tmp, lib) = lib();
    let survived = create(&lib);
    fs::write(&survived.media_path, b"partial movie fragments").unwrap();
    let empty = create(&lib);

    let done = create(&lib);
    fs::write(&done.media_path, b"ok").unwrap();
    finalize(&lib, &done.id);
    lib.set_transcription_status(&done.id, TranscriptionStatus::Running, None)
        .unwrap();
    drop(lib);

    // Simulate a fresh launch.
    let lib = Library::open(tmp.path().join("library")).unwrap();
    let report = lib.recover().unwrap();
    assert_eq!(report.recovered, vec![survived.id.clone()]);
    assert_eq!(report.discarded, vec![empty.id.clone()]);
    assert_eq!(report.requeued, vec![done.id.clone()]);

    let s = lib.get(&survived.id).unwrap().sketch;
    assert_eq!(s.status, SketchStatus::Saved);
    assert!(s.recovered);
    assert!(lib.get(&empty.id).is_err());
    assert!(!Path::new(&empty.dir).exists());
    assert_eq!(
        lib.get(&done.id).unwrap().sketch.transcription_status,
        TranscriptionStatus::Pending
    );
}

#[test]
fn export_uses_friendly_names() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);
    lib.write_file(&created.id, FileKind::Midi, b"MThd").unwrap();
    lib.write_file(&created.id, FileKind::NotesAudio, b"RIFFnotes").unwrap();
    let bundle = lib
        .prepare_export(
            &created.id,
            "Nocturne: idea / take 2",
            &[ExportKind::Recording, ExportKind::Midi, ExportKind::NotesAudio],
        )
        .unwrap();
    let names: Vec<String> = bundle
        .files
        .iter()
        .map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        vec![
            "Nocturne- idea - take 2.mov",
            "Nocturne- idea - take 2.mid",
            "Nocturne- idea - take 2 (notes).wav",
        ]
    );
    assert_eq!(fs::read(&bundle.files[0].path).unwrap(), b"movie");
    assert_eq!(fs::read(&bundle.files[1].path).unwrap(), b"MThd");
    assert!(bundle.missing.is_empty());
}

#[test]
fn export_prefers_native_take_audio_and_reports_missing() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);

    // Nothing extracted yet: audio and MIDI are missing.
    let bundle = lib
        .prepare_export(&created.id, "Take", &[ExportKind::Audio, ExportKind::Midi])
        .unwrap();
    assert!(bundle.files.is_empty());
    assert_eq!(bundle.missing, vec![ExportKind::Audio, ExportKind::Midi]);

    // Web fallback writes WAV; the native exporter writes M4A next to it.
    lib.write_file(&created.id, FileKind::TakeAudio, b"RIFFtake").unwrap();
    let wav = lib
        .prepare_export(&created.id, "Take", &[ExportKind::Audio])
        .unwrap();
    assert!(wav.files[0].path.ends_with("Take (audio).wav"));
    fs::write(Path::new(&created.dir).join("take-audio.m4a"), b"m4a").unwrap();
    let m4a = lib
        .prepare_export(&created.id, "Take", &[ExportKind::Audio, ExportKind::Audio])
        .unwrap();
    assert_eq!(m4a.files.len(), 1);
    assert!(m4a.files[0].path.ends_with("Take (audio).m4a"));
    assert_eq!(fs::read(&m4a.files[0].path).unwrap(), b"m4a");

    // A WAV written later (a mix of several tracks) wins over an older M4A.
    std::thread::sleep(std::time::Duration::from_millis(30));
    lib.write_file(&created.id, FileKind::TakeAudio, b"RIFFmix").unwrap();
    let mix = lib.prepare_export(&created.id, "Take", &[ExportKind::Audio]).unwrap();
    assert!(mix.files[0].path.ends_with("Take (audio).wav"));
    assert_eq!(fs::read(&mix.files[0].path).unwrap(), b"RIFFmix");
}

#[test]
fn update_and_delete() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);
    let s = lib
        .update(UpdateSketchArgs {
            id: created.id.clone(),
            title: Some("  Waltz idea ".into()),
            text_notes: Some("try in 3/4, left hand lighter".into()),
            duration_ms: None,
        })
        .unwrap();
    assert_eq!(s.title, "Waltz idea");
    assert_eq!(s.text_notes, "try in 3/4, left hand lighter");
    assert_eq!(s.duration_ms, Some(12_000));

    lib.delete_sketch(&created.id).unwrap();
    assert!(lib.list().unwrap().is_empty());
    assert!(!Path::new(&created.dir).exists());
}

#[test]
fn copy_out_is_confined_to_library() {
    let (tmp, lib) = lib();
    let outside = tmp.path().join("secret.txt");
    fs::write(&outside, b"x").unwrap();
    assert!(lib.copy_out(&outside, &tmp.path().join("y.txt")).is_err());
}

#[test]
fn safe_stems() {
    assert_eq!(safe_file_stem("  "), "Earbud sketch");
    assert_eq!(safe_file_stem("../.."), "-");
    assert_eq!(safe_file_stem("Ballade in G minor"), "Ballade in G minor");
}

#[test]
fn crop_range_is_stored_and_validated() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);
    let s = lib.set_crop(&created.id, Some(2_000), Some(6_500)).unwrap();
    assert_eq!((s.crop_start_ms, s.crop_end_ms), (Some(2_000), Some(6_500)));
    assert!(lib.set_crop(&created.id, Some(3_000), Some(3_050)).is_err());
    assert!(lib.set_crop(&created.id, Some(-1), None).is_err());
    let cleared = lib.set_crop(&created.id, None, None).unwrap();
    assert_eq!((cleared.crop_start_ms, cleared.crop_end_ms), (None, None));
    // The recording is untouched.
    assert_eq!(fs::read(&created.media_path).unwrap(), b"movie");
}

#[test]
fn migrates_a_v1_database() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("library");
    fs::create_dir_all(root.join("sketches")).unwrap();
    {
        // A database as written by the first release (schema v1 only).
        let conn = rusqlite::Connection::open(root.join("earbud.sqlite3")).unwrap();
        conn.execute_batch(
            "CREATE TABLE sketches (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT NOT NULL,
               duration_ms INTEGER, media_file TEXT, media_mime TEXT, has_video INTEGER NOT NULL DEFAULT 1,
               video_width INTEGER, video_height INTEGER, text_notes TEXT NOT NULL DEFAULT '',
               transcription_status TEXT NOT NULL DEFAULT 'pending', transcription_error TEXT,
               capture_backend TEXT NOT NULL DEFAULT '', recovered INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE transcriptions (sketch_id TEXT PRIMARY KEY NOT NULL, engine TEXT NOT NULL,
               engine_version TEXT NOT NULL, params_json TEXT NOT NULL, original_notes_json TEXT NOT NULL,
               edited_notes_json TEXT, summary_json TEXT, created_at INTEGER NOT NULL, edited_at INTEGER);
             INSERT INTO sketches (id, title, created_at, updated_at, status, media_file)
               VALUES ('0123456789abcdef0123456789abcdef', 'Old', 1, 1, 'saved', 'recording.mov');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let lib = Library::open(&root).unwrap();
    let sketches = lib.list().unwrap();
    assert_eq!(sketches.len(), 1);
    assert_eq!(sketches[0].title, "Old");
    assert_eq!(sketches[0].crop_start_ms, None);
    // v3: the old sketch is the only take of its one track.
    let detail = lib.get("0123456789abcdef0123456789abcdef").unwrap();
    assert_eq!(detail.tracks.len(), 1);
    assert_eq!(detail.tracks[0].name, "Track 1");
    assert_eq!(detail.tracks[0].take_id, detail.sketch.id);
    assert_eq!(detail.sketch.track_id.as_deref(), Some(detail.tracks[0].id.as_str()));
    assert_eq!(detail.sketch.offset_ms, 0);
    assert_eq!(detail.sketch.parent_id, None);
}

#[test]
fn a_new_sketch_has_one_track() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);
    let detail = lib.get(&created.id).unwrap();
    assert_eq!(detail.tracks.len(), 1);
    let track = &detail.tracks[0];
    assert_eq!(track.id, created.track_id);
    assert_eq!(track.take_id, created.id);
    assert_eq!(track.takes.len(), 1);
    assert!(!track.muted && !track.solo && !track.collapsed);
}

#[test]
fn tracks_and_takes() {
    let (_tmp, lib) = lib();
    let sketch = create(&lib);
    fs::write(&sketch.media_path, b"movie").unwrap();
    finalize(&lib, &sketch.id);

    // A take on a new track: the track exists from the start, at the end.
    let second = create_take(&lib, &sketch.id, None);
    assert_ne!(second.track_id, sketch.track_id);
    let saved = finalize_take(&lib, &second, -1_500);
    assert_eq!(saved.parent_id.as_deref(), Some(sketch.id.as_str()));
    assert_eq!(saved.offset_ms, -1_500);
    assert_eq!(saved.count_in_ms, Some(2_000));
    let detail = lib.get(&sketch.id).unwrap();
    assert_eq!(detail.tracks.len(), 2);
    assert_eq!(detail.tracks[1].name, "Track 2");
    assert_eq!(detail.tracks[1].take_id, second.id);

    // Takes are listed with their sketch, and are sketch rows of their own.
    assert_eq!(lib.list().unwrap().len(), 2);
    assert!(lib.get(&second.id).unwrap().tracks.is_empty());

    // A new take on track 1 plays once it is saved; the first take is kept.
    let retake = create_take(&lib, &sketch.id, Some(&sketch.track_id));
    assert_eq!(lib.get(&sketch.id).unwrap().tracks[0].take_id, sketch.id);
    finalize_take(&lib, &retake, 250);
    let track = lib.get(&sketch.id).unwrap().tracks.remove(0);
    assert_eq!(track.take_id, retake.id);
    assert_eq!(track.takes.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [sketch.id.as_str(), retake.id.as_str()]);

    // Mute, solo, collapse, rename, pick the other take, move it.
    let track = lib
        .update_track(UpdateTrackArgs {
            id: sketch.track_id.clone(),
            name: Some("  Left hand ".into()),
            muted: Some(true),
            solo: Some(true),
            collapsed: Some(true),
            take_id: Some(sketch.id.clone()),
            offset_ms: Some(40),
        })
        .unwrap();
    assert_eq!(track.name, "Left hand");
    assert!(track.muted && track.solo && track.collapsed);
    assert_eq!(track.take_id, sketch.id);
    assert_eq!(lib.get(&sketch.id).unwrap().sketch.offset_ms, 40);
    // A take of another track cannot be chosen.
    assert!(lib
        .update_track(UpdateTrackArgs {
            id: sketch.track_id.clone(),
            name: None,
            muted: None,
            solo: None,
            collapsed: None,
            take_id: Some(second.id.clone()),
            offset_ms: None,
        })
        .is_err());

    // Takes cannot hang off takes, and tracks belong to their own sketch.
    assert!(lib
        .create_sketch(CreateSketchArgs {
            media_extension: "mov".into(),
            media_mime: "video/quicktime".into(),
            capture_backend: "test".into(),
            title: None,
            parent_id: Some(second.id.clone()),
            track_id: None,
        })
        .is_err());
    let other = create(&lib);
    assert!(lib
        .create_sketch(CreateSketchArgs {
            media_extension: "mov".into(),
            media_mime: "video/quicktime".into(),
            capture_backend: "test".into(),
            title: None,
            parent_id: Some(other.id.clone()),
            track_id: Some(sketch.track_id.clone()),
        })
        .is_err());
}

#[test]
fn deleting_takes_tracks_and_sketches() {
    let (_tmp, lib) = lib();
    let sketch = create(&lib);
    fs::write(&sketch.media_path, b"movie").unwrap();
    finalize(&lib, &sketch.id);
    let retake = create_take(&lib, &sketch.id, Some(&sketch.track_id));
    finalize_take(&lib, &retake, 0);
    let second = create_take(&lib, &sketch.id, None);
    finalize_take(&lib, &second, 0);
    let third = create_take(&lib, &sketch.id, Some(&second.track_id));
    finalize_take(&lib, &third, 0);

    // The sketch's own recording and its track stay.
    assert!(lib.delete_take(&sketch.id).is_err());
    assert!(lib.delete_track(&sketch.track_id).is_err());

    // Deleting the take that plays falls back to the track's latest other take.
    lib.delete_take(&retake.id).unwrap();
    assert!(!Path::new(&retake.dir).exists());
    assert_eq!(lib.get(&sketch.id).unwrap().tracks[0].take_id, sketch.id);

    // A track goes with every take.
    lib.delete_track(&second.track_id).unwrap();
    assert!(!Path::new(&second.dir).exists() && !Path::new(&third.dir).exists());
    assert_eq!(lib.get(&sketch.id).unwrap().tracks.len(), 1);

    // Deleting the sketch removes its takes and their folders.
    let fourth = create_take(&lib, &sketch.id, None);
    finalize_take(&lib, &fourth, 0);
    lib.delete_sketch(&sketch.id).unwrap();
    assert!(!Path::new(&fourth.dir).exists());
    assert!(lib.get(&fourth.id).is_err());
    assert!(lib.list().unwrap().is_empty());
}

#[test]
fn discarded_and_recovered_takes() {
    let (_tmp, lib) = lib();
    let sketch = create(&lib);
    fs::write(&sketch.media_path, b"movie").unwrap();
    finalize(&lib, &sketch.id);

    // A new track whose recording never started goes away with its take.
    let failed = create_take(&lib, &sketch.id, None);
    assert_eq!(lib.get(&sketch.id).unwrap().tracks.len(), 2);
    lib.discard_sketch(&failed.id).unwrap();
    assert_eq!(lib.get(&sketch.id).unwrap().tracks.len(), 1);
    assert!(!Path::new(&failed.dir).exists());

    // After a crash: a take with data is kept (not yet playing), an empty one removed.
    let kept = create_take(&lib, &sketch.id, Some(&sketch.track_id));
    fs::write(&kept.media_path, b"partial").unwrap();
    let empty = create_take(&lib, &sketch.id, None);
    let report = lib.recover().unwrap();
    assert_eq!(report.recovered, vec![kept.id.clone()]);
    assert_eq!(report.discarded, vec![empty.id.clone()]);
    let detail = lib.get(&sketch.id).unwrap();
    assert_eq!(detail.tracks.len(), 1);
    assert_eq!(detail.tracks[0].takes.len(), 2);
    assert_eq!(detail.tracks[0].take_id, sketch.id);
}
