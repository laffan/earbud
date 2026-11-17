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
        ..Default::default()
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
        ..Default::default()
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
        ..Default::default()
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
        ..Default::default()
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
            ..Default::default()
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
            listen_mode: None,
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
    assert_eq!(sketches[0].listen_mode, "recording");
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
            ..Default::default()
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
            ..Default::default()
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

#[test]
fn tempo_is_stored_and_validated() {
    let (_tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    let sketch = finalize(&lib, &created.id);
    assert_eq!((sketch.tempo_bpm, sketch.beat_ms, sketch.tempo_source), (None, None, None));

    let sketch = lib.set_tempo(&created.id, Some(92.5), Some(410), Some("detected")).unwrap();
    assert_eq!(sketch.tempo_bpm, Some(92.5));
    assert_eq!(sketch.beat_ms, Some(410));
    assert_eq!(sketch.tempo_source.as_deref(), Some("detected"));

    assert!(lib.set_tempo(&created.id, Some(5.0), None, Some("user")).is_err());
    assert!(lib.set_tempo(&created.id, Some(f64::NAN), None, Some("user")).is_err());
    assert!(lib.set_tempo(&created.id, Some(100.0), None, Some("guess")).is_err());

    // Clearing the tempo clears its beat and source too.
    let cleared = lib.set_tempo(&created.id, None, Some(1), Some("user")).unwrap();
    assert_eq!((cleared.tempo_bpm, cleared.beat_ms, cleared.tempo_source), (None, None, None));
}

// -------------------------------------------------------------- notebooks

fn create_on(lib: &Library, notebook: &str, x_ms: i64, y: f64) -> CreatedSketch {
    lib.create_sketch(CreateSketchArgs {
        media_extension: "webm".into(),
        media_mime: "audio/webm".into(),
        capture_backend: "test".into(),
        notebook_id: Some(notebook.into()),
        canvas_x_ms: Some(x_ms),
        canvas_y: Some(y),
        ..Default::default()
    })
    .unwrap()
}

fn pattern() -> serde_json::Value {
    serde_json::json!({ "version": 1, "bpm": 96.0, "stepsPerBeat": 4, "beatsPerBar": 4, "bars": 1, "lengthBars": 1,
                        "pads": [[1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0], [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0], [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1]] })
}

#[test]
fn notebooks_are_created_listed_renamed_and_looped() {
    let (_dir, lib) = lib();
    assert!(lib.list_notebooks().unwrap().is_empty());
    let a = lib.create_notebook("  First  ").unwrap();
    let b = lib.create_notebook("Second").unwrap();
    assert_eq!(a.title, "First");
    let all = lib.list_notebooks().unwrap();
    assert_eq!(all.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec![a.id.as_str(), b.id.as_str()]);

    assert_eq!(lib.rename_notebook(&a.id, "Ideas").unwrap().title, "Ideas");
    let looped = lib.set_notebook_loop(&a.id, Some(1_000), Some(9_000)).unwrap();
    assert_eq!((looped.loop_start_ms, looped.loop_end_ms), (Some(1_000), Some(9_000)));
    assert!(lib.set_notebook_loop(&a.id, Some(1_000), Some(1_100)).is_err());
    let cleared = lib.set_notebook_loop(&a.id, None, None).unwrap();
    assert_eq!((cleared.loop_start_ms, cleared.loop_end_ms), (None, None));
    assert!(lib.rename_notebook(&"0".repeat(32), "x").is_err());
}

#[test]
fn a_recording_is_placed_on_its_notebook_and_moved() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let created = create_on(&lib, &notebook.id, 4_000, 120.0);
    fs::write(&created.media_path, b"sound").unwrap();
    // The downbeat lands where the press was: the recording's time 0 is earlier.
    let saved = lib
        .finalize_sketch(FinalizeSketchArgs {
            id: created.id.clone(),
            duration_ms: Some(6_000),
            count_in_ms: Some(2_000),
            canvas_x_ms: Some(2_000),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(saved.notebook_id.as_deref(), Some(notebook.id.as_str()));
    assert_eq!((saved.canvas_x_ms, saved.canvas_y), (2_000, 120.0));
    assert_eq!(saved.kind, "audio");

    let moved = lib
        .place_sketch(PlaceSketchArgs { id: created.id.clone(), notebook_id: None, canvas_x_ms: 10_000, canvas_y: 40.0 })
        .unwrap();
    assert_eq!((moved.canvas_x_ms, moved.canvas_y), (10_000, 40.0));
    assert!(lib
        .place_sketch(PlaceSketchArgs { id: created.id.clone(), notebook_id: None, canvas_x_ms: 0, canvas_y: f64::NAN })
        .is_err());
    // An unknown notebook is refused, at creation and when moving.
    assert!(lib
        .create_sketch(CreateSketchArgs {
            media_extension: "webm".into(),
            media_mime: "audio/webm".into(),
            capture_backend: "test".into(),
            notebook_id: Some("f".repeat(32)),
            ..Default::default()
        })
        .is_err());
    assert!(lib
        .place_sketch(PlaceSketchArgs { id: created.id, notebook_id: Some("f".repeat(32)), canvas_x_ms: 0, canvas_y: 0.0 })
        .is_err());
}

#[test]
fn rhythm_sketches_store_their_pattern_and_have_no_recording() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let rhythm = lib
        .create_rhythm(CreateRhythmArgs {
            notebook_id: notebook.id.clone(),
            canvas_x_ms: 1_500,
            canvas_y: 300.0,
            title: Some("Groove".into()),
            rhythm: pattern(),
            duration_ms: 2_500,
        })
        .unwrap();
    assert_eq!(rhythm.kind, "rhythm");
    assert_eq!(rhythm.status, SketchStatus::Saved);
    assert_eq!(rhythm.transcription_status, TranscriptionStatus::Done);
    assert!(rhythm.media_path.is_none());
    assert_eq!(rhythm.duration_ms, Some(2_500));
    assert_eq!(rhythm.rhythm.as_ref().unwrap()["bpm"], 96.0);

    let mut longer = pattern();
    longer["lengthBars"] = 3.into();
    let updated = lib
        .update_rhythm(UpdateRhythmArgs { id: rhythm.id.clone(), rhythm: longer, duration_ms: 7_500 })
        .unwrap();
    assert_eq!(updated.duration_ms, Some(7_500));
    assert_eq!(updated.rhythm.unwrap()["lengthBars"], 3);
    assert!(lib
        .update_rhythm(UpdateRhythmArgs { id: rhythm.id.clone(), rhythm: serde_json::json!([1, 2]), duration_ms: 1_000 })
        .is_err());

    // Recording into it is impossible, and nothing about it is queued.
    assert!(lib.write_file(&rhythm.id, FileKind::MediaChunk, b"x").is_err());
    assert!(lib.recover().unwrap().requeued.is_empty());
    // An audio sketch is not a rhythm.
    let audio = create_on(&lib, &notebook.id, 0, 0.0);
    assert!(lib
        .update_rhythm(UpdateRhythmArgs { id: audio.id, rhythm: pattern(), duration_ms: 1_000 })
        .is_err());
}

#[test]
fn deleting_a_notebook_deletes_its_sketches_only() {
    let (_dir, lib) = lib();
    let keep = lib.create_notebook("Keep").unwrap();
    let gone = lib.create_notebook("Gone").unwrap();
    let kept = create_on(&lib, &keep.id, 0, 0.0);
    let doomed = create_on(&lib, &gone.id, 0, 0.0);
    let beat = lib
        .create_rhythm(CreateRhythmArgs {
            notebook_id: gone.id.clone(),
            canvas_x_ms: 0,
            canvas_y: 0.0,
            title: None,
            rhythm: pattern(),
            duration_ms: 2_500,
        })
        .unwrap();
    lib.delete_notebook(&gone.id).unwrap();
    assert!(lib.get(&doomed.id).is_err());
    assert!(lib.get(&beat.id).is_err());
    assert!(!lib.sketch_dir(&doomed.id).exists());
    assert!(!lib.sketch_dir(&beat.id).exists());
    assert!(lib.get(&kept.id).is_ok());
    assert_eq!(lib.list_notebooks().unwrap().len(), 1);
    assert!(lib.delete_notebook(&gone.id).is_err());
}

#[test]
fn a_recording_repeats_on_the_canvas() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let created = create_on(&lib, &notebook.id, 0, 0.0);
    fs::write(&created.media_path, b"sound").unwrap();
    lib.finalize_sketch(FinalizeSketchArgs { id: created.id.clone(), duration_ms: Some(4_000), ..Default::default() })
        .unwrap();
    assert_eq!(lib.get(&created.id).unwrap().sketch.canvas_repeats, 1);
    assert_eq!(lib.set_sketch_repeats(&created.id, 6).unwrap().canvas_repeats, 6);
    assert!(lib.set_sketch_repeats(&created.id, 0).is_err());
    assert!(lib.set_sketch_repeats(&created.id, MAX_CANVAS_REPEATS + 1).is_err());
}

#[test]
fn a_sketch_has_a_canvas_volume_from_zero_to_one() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let created = create_on(&lib, &notebook.id, 0, 0.0);
    fs::write(&created.media_path, b"sound").unwrap();
    lib.finalize_sketch(FinalizeSketchArgs { id: created.id.clone(), duration_ms: Some(4_000), ..Default::default() })
        .unwrap();
    assert_eq!(lib.get(&created.id).unwrap().sketch.canvas_volume, 1.0);
    assert_eq!(lib.set_sketch_volume(&created.id, 0.4).unwrap().canvas_volume, 0.4);
    assert_eq!(lib.set_sketch_volume(&created.id, 0.0).unwrap().canvas_volume, 0.0);
    assert!(lib.set_sketch_volume(&created.id, -0.1).is_err());
    assert!(lib.set_sketch_volume(&created.id, 1.5).is_err());
    assert!(lib.set_sketch_volume(&created.id, f64::NAN).is_err());
    assert_eq!(lib.list().unwrap()[0].canvas_volume, 0.0);
}

#[test]
fn duplicating_a_recording_copies_its_files_notes_and_settings() {
    let (_dir, lib) = lib();
    let first = lib.create_notebook("A").unwrap();
    let second = lib.create_notebook("B").unwrap();
    let created = create_on(&lib, &first.id, 1_000, 50.0);
    fs::write(&created.media_path, b"the take").unwrap();
    lib.finalize_sketch(FinalizeSketchArgs {
        id: created.id.clone(),
        duration_ms: Some(6_000),
        count_in_ms: Some(1_500),
        ..Default::default()
    })
    .unwrap();
    lib.write_file(&created.id, FileKind::Analysis, b"analysis").unwrap();
    lib.save_transcription(SaveTranscriptionArgs {
        id: created.id.clone(),
        engine: "test".into(),
        engine_version: "1".into(),
        params: serde_json::json!({}),
        notes: vec![note(60, 0.5, 1.0)],
        summary: None,
    })
    .unwrap();
    lib.save_edits(SaveEditsArgs { id: created.id.clone(), notes: vec![note(62, 0.5, 1.0)], summary: None }).unwrap();
    lib.update(UpdateSketchArgs { id: created.id.clone(), title: Some("Riff".into()), text_notes: Some("left hand".into()), duration_ms: None, listen_mode: Some("both".into()) })
        .unwrap();
    lib.set_crop(&created.id, Some(2_000), Some(5_000)).unwrap();
    lib.set_sketch_repeats(&created.id, 3).unwrap();
    lib.set_sketch_volume(&created.id, 0.25).unwrap();
    // A half-written export and an exports folder are not copied.
    lib.prepare_export(&created.id, "Riff", &[ExportKind::Recording]).unwrap();

    let copy = lib
        .duplicate_sketch(DuplicateSketchArgs { id: created.id.clone(), notebook_id: second.id.clone(), canvas_x_ms: 9_000, canvas_y: 300.0 })
        .unwrap();
    assert_ne!(copy.id, created.id);
    assert_eq!(copy.notebook_id.as_deref(), Some(second.id.as_str()));
    assert_eq!((copy.canvas_x_ms, copy.canvas_y), (9_000, 300.0));
    assert_eq!(copy.title, "Riff");
    assert_eq!(copy.text_notes, "left hand");
    assert_eq!(copy.listen_mode, "both");
    assert_eq!((copy.crop_start_ms, copy.crop_end_ms, copy.count_in_ms), (Some(2_000), Some(5_000), Some(1_500)));
    assert_eq!(copy.canvas_repeats, 3);
    assert_eq!(copy.canvas_volume, 0.25);
    assert!(copy.has_edits);
    assert_eq!(fs::read(copy.media_path.as_ref().unwrap()).unwrap(), b"the take");
    assert!(copy.analysis_path.is_some());
    assert!(!lib.sketch_dir(&copy.id).join("exports").exists());
    let detail = lib.get(&copy.id).unwrap();
    assert_eq!(detail.transcription.unwrap().edited_notes.unwrap()[0].pitch, 62);
    assert_eq!(detail.tracks.len(), 1);
    assert_eq!(detail.tracks[0].take_id, copy.id);

    // Each stands on its own: deleting the original leaves the copy whole.
    lib.delete_sketch(&created.id).unwrap();
    assert_eq!(fs::read(lib.get(&copy.id).unwrap().sketch.media_path.unwrap()).unwrap(), b"the take");
}

#[test]
fn duplicating_a_rhythm_and_what_cannot_be_duplicated() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let rhythm = lib
        .create_rhythm(CreateRhythmArgs {
            notebook_id: notebook.id.clone(),
            canvas_x_ms: 0,
            canvas_y: 0.0,
            title: Some("Groove".into()),
            rhythm: pattern(),
            duration_ms: 2_500,
        })
        .unwrap();
    let copy = lib
        .duplicate_sketch(DuplicateSketchArgs { id: rhythm.id.clone(), notebook_id: notebook.id.clone(), canvas_x_ms: 2_500, canvas_y: 0.0 })
        .unwrap();
    assert_eq!(copy.kind, "rhythm");
    assert_eq!(copy.rhythm, rhythm.rhythm);
    assert_eq!(copy.title, "Groove");
    assert!(copy.track_id.is_none());
    // A rhythm has no recording to export: it is reported missing, not an error.
    let bundle = lib.prepare_export(&copy.id, "Groove", &[ExportKind::Recording]).unwrap();
    assert_eq!(bundle.missing, vec![ExportKind::Recording]);

    // Still recording, or unknown: refused.
    let recording = create_on(&lib, &notebook.id, 0, 0.0);
    let args = |id: &str| DuplicateSketchArgs { id: id.into(), notebook_id: notebook.id.clone(), canvas_x_ms: 0, canvas_y: 0.0 };
    assert!(lib.duplicate_sketch(args(&recording.id)).is_err());
    assert!(lib.duplicate_sketch(args(&"0".repeat(32))).is_err());
}

#[test]
fn text_notes_are_placed_edited_resized_and_copied() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let note = lib
        .create_text_note(CreateTextNoteArgs {
            notebook_id: notebook.id.clone(),
            canvas_x_ms: 3_000,
            canvas_y: 40.0,
            text: "**Bridge** idea".into(),
            canvas_w: None,
            canvas_h: None,
        })
        .unwrap();
    assert_eq!(note.kind, "text");
    assert_eq!(note.text_notes, "**Bridge** idea");
    assert_eq!((note.canvas_w, note.canvas_h), (None, None));
    assert!(note.media_path.is_none());
    assert_eq!(note.transcription_status, TranscriptionStatus::Done);

    let edited = lib
        .update_text_note(UpdateTextNoteArgs { id: note.id.clone(), text: Some("🎹".into()), canvas_w: None, canvas_h: None, clear_size: false })
        .unwrap();
    assert_eq!(edited.text_notes, "🎹");
    let resized = lib
        .update_text_note(UpdateTextNoteArgs { id: note.id.clone(), text: None, canvas_w: Some(300.0), canvas_h: Some(120.0), clear_size: false })
        .unwrap();
    assert_eq!((resized.text_notes.as_str(), resized.canvas_w, resized.canvas_h), ("🎹", Some(300.0), Some(120.0)));
    assert!(lib
        .update_text_note(UpdateTextNoteArgs { id: note.id.clone(), text: None, canvas_w: Some(f64::NAN), canvas_h: None, clear_size: false })
        .is_err());
    assert!(lib
        .update_text_note(UpdateTextNoteArgs { id: note.id.clone(), text: Some("x".repeat(MAX_NOTE_CHARS + 1)), canvas_w: None, canvas_h: None, clear_size: false })
        .is_err());

    let copy = lib
        .duplicate_sketch(DuplicateSketchArgs { id: note.id.clone(), notebook_id: notebook.id.clone(), canvas_x_ms: 3_000, canvas_y: 200.0 })
        .unwrap();
    assert_eq!((copy.kind.as_str(), copy.text_notes.as_str(), copy.canvas_w, copy.canvas_h), ("text", "🎹", Some(300.0), Some(120.0)));
    let fitted = lib
        .update_text_note(UpdateTextNoteArgs { id: copy.id.clone(), text: None, canvas_w: None, canvas_h: None, clear_size: true })
        .unwrap();
    assert_eq!((fitted.canvas_w, fitted.canvas_h), (None, None));

    // Only text notes take text-note edits.
    let audio = create_on(&lib, &notebook.id, 0, 0.0);
    assert!(lib
        .update_text_note(UpdateTextNoteArgs { id: audio.id, text: Some("x".into()), canvas_w: None, canvas_h: None, clear_size: false })
        .is_err());
    lib.delete_notebook(&notebook.id).unwrap();
    assert!(lib.get(&note.id).is_err());
}

#[test]
fn listen_mode_survives_reopening_and_rejects_invalid_values() {
    let (tmp, lib) = lib();
    let created = create(&lib);
    fs::write(&created.media_path, b"movie").unwrap();
    finalize(&lib, &created.id);
    assert_eq!(lib.get(&created.id).unwrap().sketch.listen_mode, "recording");
    for mode in ["notes", "both", "recording", "notes"] {
        let args: UpdateSketchArgs = serde_json::from_value(serde_json::json!({
            "id": created.id, "listenMode": mode
        })).unwrap();
        assert_eq!(lib.update(args).unwrap().listen_mode, mode);
    }
    drop(lib);
    let reopened = Library::open(tmp.path().join("library")).unwrap();
    assert_eq!(reopened.get(&created.id).unwrap().sketch.listen_mode, "notes");
    assert_eq!(reopened.list().unwrap()[0].listen_mode, "notes");
    let rename: UpdateSketchArgs = serde_json::from_value(serde_json::json!({
        "id": created.id, "title": "Renamed"
    })).unwrap();
    assert_eq!(reopened.update(rename).unwrap().listen_mode, "notes");
    let invalid: UpdateSketchArgs = serde_json::from_value(serde_json::json!({
        "id": created.id, "listenMode": "invalid", "title": "Must not change"
    })).unwrap();
    assert!(reopened.update(invalid).is_err());
    let saved = reopened.get(&created.id).unwrap().sketch;
    assert_eq!(saved.listen_mode, "notes");
    assert_eq!(saved.title, "Renamed");
}

// ---------------------------------------------------------------- samples

/// A tiny valid WAV file (44-byte header and a few samples).
fn wav_bytes() -> Vec<u8> {
    let samples: [i16; 8] = [0, 1000, 2000, 1000, 0, -1000, -2000, -1000];
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&44_100u32.to_le_bytes());
    out.extend_from_slice(&(44_100u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

#[test]
fn samples_are_created_written_once_updated_and_deleted() {
    let (_dir, lib) = lib();
    let source = create(&lib);
    fs::write(&source.media_path, b"take").unwrap();
    finalize(&lib, &source.id);
    let sample = lib
        .create_sample(CreateSampleArgs {
            title: Some("  Low C  ".into()),
            duration_ms: Some(1200),
            source_sketch_id: Some(source.id.clone()),
            source_start_ms: Some(500),
            source_end_ms: Some(1700),
            settings: Some(serde_json::json!({ "version": 1, "gainDb": -3 })),
        })
        .unwrap();
    assert_eq!(sample.title, "Low C");
    assert!(sample.audio_path.is_none(), "no audio until it is written");
    assert_eq!(sample.settings["gainDb"], -3);

    let path = lib.write_sample_audio(&sample.id, &wav_bytes()).unwrap();
    assert!(path.is_file());
    assert!(path.starts_with(lib.samples_dir()));
    // The stored audio is written once.
    assert!(lib.write_sample_audio(&sample.id, &wav_bytes()).is_err());
    assert!(lib.get_sample(&sample.id).unwrap().audio_path.is_some());

    let updated = lib
        .update_sample(UpdateSampleArgs {
            id: sample.id.clone(),
            title: Some("Bass".into()),
            settings: Some(serde_json::json!({ "version": 1, "reverb": 0.4 })),
        })
        .unwrap();
    assert_eq!(updated.title, "Bass");
    assert_eq!(updated.settings["reverb"], 0.4);
    assert!(updated.updated_at >= sample.updated_at);
    assert_eq!(lib.list_samples().unwrap().len(), 1);

    // A sketch plays its notes with it; deleting the sample sends it back to the piano.
    let sketch = lib.set_note_sample(&source.id, Some(&sample.id)).unwrap();
    assert_eq!(sketch.note_sample_id.as_deref(), Some(sample.id.as_str()));
    lib.delete_sample(&sample.id).unwrap();
    assert!(lib.list_samples().unwrap().is_empty());
    assert!(!lib.sample_dir(&sample.id).exists());
    assert_eq!(lib.get(&source.id).unwrap().sketch.note_sample_id, None);
}

#[test]
fn samples_reject_bad_input() {
    let (_dir, lib) = lib();
    let source = create(&lib);
    fs::write(&source.media_path, b"take").unwrap();
    finalize(&lib, &source.id);
    assert!(lib.create_sample(CreateSampleArgs { duration_ms: Some(0), ..Default::default() }).is_err());
    assert!(lib.create_sample(CreateSampleArgs { duration_ms: Some(120_000), ..Default::default() }).is_err());
    assert!(lib
        .create_sample(CreateSampleArgs { source_start_ms: Some(900), source_end_ms: Some(100), ..Default::default() })
        .is_err());
    assert!(lib
        .create_sample(CreateSampleArgs { settings: Some(serde_json::json!([1, 2])), ..Default::default() })
        .is_err());
    let sample = lib.create_sample(CreateSampleArgs::default()).unwrap();
    assert!(lib.write_sample_audio(&sample.id, b"not a wav file at all, but long enough to be checked..").is_err());
    assert!(lib.write_sample_audio("../../etc", &wav_bytes()).is_err());
    assert!(lib.set_note_sample(&source.id, Some("0123456789abcdef0123456789abcdef")).is_err());
    assert!(lib.update_sample(UpdateSampleArgs { id: "0123456789abcdef0123456789abcdef".into(), title: None, settings: None }).is_err());
}

#[test]
fn duplicates_keep_the_note_sample() {
    let (_dir, lib) = lib();
    let notebook = lib.create_notebook("N").unwrap();
    let source = create(&lib);
    fs::write(&source.media_path, b"take").unwrap();
    finalize(&lib, &source.id);
    lib.place_sketch(PlaceSketchArgs { id: source.id.clone(), notebook_id: Some(notebook.id.clone()), canvas_x_ms: 0, canvas_y: 0.0 }).unwrap();
    let sample = lib.create_sample(CreateSampleArgs::default()).unwrap();
    lib.set_note_sample(&source.id, Some(&sample.id)).unwrap();
    let copy = lib
        .duplicate_sketch(DuplicateSketchArgs { id: source.id.clone(), notebook_id: notebook.id, canvas_x_ms: 5000, canvas_y: 10.0 })
        .unwrap();
    assert_eq!(copy.note_sample_id.as_deref(), Some(sample.id.as_str()));
}
