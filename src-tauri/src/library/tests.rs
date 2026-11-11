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
