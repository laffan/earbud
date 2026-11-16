//! MIDI snapshots live independently of sketches. Completion is one database
//! transaction; interrupted reservations are discarded before capture recovery.
use super::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiSnapshot {
    pub notes: Vec<PianoNote>,
    pub tempo_bpm: Option<f64>,
    /// Original MIDI track/channel/tempo map and other source metadata.
    pub metadata: serde_json::Value,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMidiSession {
    pub source_id: String,
    pub midi: Vec<u8>,
    pub snapshot: MidiSnapshot,
    pub destination: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiSession {
    pub id: String,
    pub source_id: String,
    pub source_title: String,
    pub snapshot: MidiSnapshot,
    pub midi_hash: String,
    pub destination: serde_json::Value,
    pub created_at: i64,
    pub status: String,
    pub result_id: Option<String>,
    pub import_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginMidiImport {
    pub session_id: String,
    pub media_extension: String,
    pub media_mime: String,
    pub notebook_id: String,
    pub canvas_x_ms: i64,
    pub canvas_y: f64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteMidiImport {
    pub session_id: String,
    pub duration_ms: i64,
    pub original_filename: String,
    pub summary: Option<serde_json::Value>,
    pub metadata: serde_json::Value,
}

impl Library {
    pub fn set_midi_offset(&self, id: &str, offset: f64) -> Result<Sketch> {
        validate_id(id)?;
        if !offset.is_finite() || offset.abs() > 3600000.0 { return Err(Error::Invalid("Invalid audio/MIDI offset".into())); }
        if self.get(id)?.sketch.capture_backend != "midi-round-trip" { return Err(Error::Invalid("Alignment is for MIDI round-trip sketches".into())); }
        let mut conn = self.conn(); let tx = conn.transaction()?;
        tx.execute("UPDATE sketches SET audio_midi_offset_ms=?2 WHERE id=?1", params![id,offset])?;
        tx.execute("UPDATE midi_provenance SET offset_ms=?2 WHERE sketch_id=?1", params![id,offset])?;
        tx.commit()?; drop(conn);
        Ok(self.get(id)?.sketch)
    }

    fn midi_session_row(row: &Row<'_>) -> rusqlite::Result<MidiSession> {
        fn json<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: &str) -> rusqlite::Result<T> {
            let text: String = row.get(column)?;
            serde_json::from_str(&text).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
        }
        Ok(MidiSession {
            id: row.get("id")?, source_id: row.get("source_id")?, source_title: row.get("source_title")?,
            snapshot: json(row, "snapshot_json")?, midi_hash: row.get("midi_hash")?,
            destination: json(row, "destination_json")?, created_at: row.get("created_at")?,
            status: row.get("status")?, result_id: row.get("result_id")?, import_id: row.get("import_id")?,
        })
    }
    pub fn midi_session(&self, id: &str) -> Result<MidiSession> {
        validate_id(id)?;
        self.conn().query_row("SELECT * FROM midi_sessions WHERE id=?1", [id], Self::midi_session_row)
            .optional()?.ok_or_else(|| Error::NotFound(id.into()))
    }
    pub fn midi_sessions(&self) -> Result<Vec<MidiSession>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM midi_sessions ORDER BY created_at DESC, id")?;
        let rows = stmt.query_map([], Self::midi_session_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn midi_session_bytes(&self, id: &str) -> Result<Vec<u8>> {
        validate_id(id)?;
        Ok(self.conn().query_row("SELECT midi FROM midi_sessions WHERE id=?1", [id], |r| r.get(0))?)
    }
    pub fn create_midi_session(&self, args: CreateMidiSession) -> Result<MidiSession> {
        let source = self.get(&args.source_id)?;
        validate_notes(&args.snapshot.notes)?;
        if args.snapshot.notes.is_empty() || args.midi.len() < 14 || args.midi.len() > 16 * 1024 * 1024 || !args.midi.starts_with(b"MThd") {
            return Err(Error::Invalid("A nonempty MIDI snapshot is required (maximum 16 MB)".into()));
        }
        if args.snapshot.tempo_bpm.is_some_and(|n| !n.is_finite() || n <= 0.0) {
            return Err(Error::Invalid("Invalid MIDI tempo".into()));
        }
        let id = new_id();
        let hash = format!("{:x}", Sha256::digest(&args.midi));
        // The BLOB is authoritative and crash durable. The file is an immutable
        // native/export convenience copy, re-created from the BLOB if needed.
        let dir = self.root.join("midi-sessions").join(&id);
        fs::create_dir_all(&dir)?;
        let mut file = fs::File::create(dir.join("original.mid"))?;
        file.write_all(&args.midi)?;
        file.sync_all()?;
        self.conn().execute("INSERT INTO midi_sessions (id,source_id,source_title,snapshot_json,midi,midi_hash,destination_json,created_at,status) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'pending')",
            params![id, args.source_id, source.sketch.title, serde_json::to_string(&args.snapshot)?, args.midi, hash, args.destination.to_string(), now_ms()])?;
        self.midi_session(&id)
    }
    pub fn set_midi_session_status(&self, id: &str, status: &str) -> Result<MidiSession> {
        validate_id(id)?;
        if !matches!(status, "pending" | "cancelled" | "archived") { return Err(Error::Invalid("Invalid session transition".into())); }
        let session = self.midi_session(id)?;
        if session.status == "importing" { self.abort_midi_import(id)?; }
        if session.result_id.is_some() && status != "archived" { return Err(Error::Invalid("Completed sessions can only be archived".into())); }
        self.conn().execute("UPDATE midi_sessions SET status=?2 WHERE id=?1", params![id,status])?;
        self.midi_session(id)
    }
    pub fn begin_midi_import(&self, args: BeginMidiImport) -> Result<CreatedSketch> {
        let session = self.midi_session(&args.session_id)?;
        if session.status != "pending" { return Err(Error::Invalid("Session is not awaiting audio".into())); }
        let created = self.create_sketch(CreateSketchArgs {
            media_extension: args.media_extension, media_mime: args.media_mime,
            capture_backend: "midi-round-trip".into(), title: Some(format!("{} — instrument", session.source_title)),
            notebook_id: Some(args.notebook_id), canvas_x_ms: Some(args.canvas_x_ms), canvas_y: Some(args.canvas_y), ..Default::default()
        })?;
        let changed = self.conn().execute("UPDATE midi_sessions SET status='importing', import_id=?2 WHERE id=?1 AND status='pending'", params![args.session_id,created.id])?;
        if changed == 0 { self.discard_sketch(&created.id)?; return Err(Error::Invalid("Session already importing".into())); }
        Ok(created)
    }
    pub fn abort_midi_import(&self, id: &str) -> Result<()> {
        let session = self.midi_session(id)?;
        if let Some(import) = session.import_id { self.discard_sketch(&import)?; }
        self.conn().execute("UPDATE midi_sessions SET status='pending', import_id=NULL WHERE id=?1 AND status='importing'", [id])?;
        Ok(())
    }
    pub(super) fn recover_midi_imports(&self) -> Result<()> {
        for s in self.midi_sessions()? { if s.status == "importing" { self.abort_midi_import(&s.id)?; } }
        // Also discard reservations made just before the session row was updated.
        let ids = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM sketches WHERE capture_backend='midi-round-trip' AND status='recording'")?;
            let ids = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        for id in ids { self.discard_sketch(&id)?; }
        Ok(())
    }
    pub fn complete_midi_import(&self, args: CompleteMidiImport) -> Result<SketchDetail> {
        let session = self.midi_session(&args.session_id)?;
        if let Some(id) = session.result_id { return self.get(&id); } // idempotent retries
        if session.status != "importing" || args.duration_ms <= 0 { return Err(Error::Invalid("No valid import to complete".into())); }
        let id = session.import_id.ok_or_else(|| Error::Invalid("Missing import reservation".into()))?;
        let media = self.media_path(&id)?;
        if fs::metadata(&media)?.len() == 0 || fs::metadata(self.sketch_dir(&id).join(ANALYSIS_FILE))?.len() <= 44 {
            return Err(Error::Invalid("Audio and decoded waveform are required".into()));
        }
        fs::File::open(&media)?.sync_all()?;
        let bytes = self.midi_session_bytes(&session.id)?;
        fs::write(self.sketch_dir(&id).join("original.mid"), &bytes)?;
        fs::write(self.sketch_dir(&id).join(MIDI_FILE), &bytes)?;
        let metadata = serde_json::json!({"sourceSketchId":session.source_id,"sessionId":session.id,"midiHash":session.midi_hash,"destination":session.destination,"importedAt":now_ms(),"originalFilename":args.original_filename,"render":args.metadata});
        {
            let mut conn = self.conn();
            let tx = conn.transaction()?;
            let current: String = tx.query_row("SELECT status FROM midi_sessions WHERE id=?1", [&session.id], |r| r.get(0))?;
            if current != "importing" { return Err(Error::Invalid("Session changed during import".into())); }
            tx.execute("INSERT INTO transcriptions (sketch_id,engine,engine_version,params_json,original_notes_json,summary_json,created_at) VALUES (?1,'midi-round-trip','1',?2,?3,?4,?5)", params![id,metadata.to_string(),serde_json::to_string(&session.snapshot.notes)?,args.summary.map(|s|s.to_string()),now_ms()])?;
            tx.execute("INSERT INTO midi_provenance (sketch_id,session_id,metadata_json) VALUES (?1,?2,?3)", params![id,session.id,metadata.to_string()])?;
            tx.execute("UPDATE sketches SET status='saved',transcription_status='done',duration_ms=?2,tempo_bpm=?3,updated_at=?4 WHERE id=?1", params![id,args.duration_ms,session.snapshot.tempo_bpm,now_ms()])?;
            tx.execute("UPDATE midi_sessions SET status='completed',result_id=?2,import_id=NULL WHERE id=?1", params![session.id,id])?;
            tx.commit()?;
        }
        self.get(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source(lib: &Library) -> (String, String) {
        let book = lib.create_notebook("MIDI").unwrap();
        let sketch = lib.create_sketch(CreateSketchArgs { media_extension:"wav".into(), media_mime:"audio/wav".into(), capture_backend:"import".into(), title:Some("Source".into()), notebook_id:Some(book.id.clone()), ..Default::default() }).unwrap();
        lib.write_file(&sketch.id,FileKind::MediaChunk,b"source audio").unwrap();
        lib.finalize_sketch(FinalizeSketchArgs { id:sketch.id.clone(), duration_ms:Some(1000), ..Default::default() }).unwrap();
        (sketch.id,book.id)
    }
    fn session(lib: &Library, source: &str) -> MidiSession {
        lib.create_midi_session(CreateMidiSession {
            source_id:source.into(), midi:b"MThd\0\0\0\x06\0\x01\0\x01\x01\xe0MTrk\0\0\0\x04\0\xff\x2f\0".to_vec(),
            snapshot:MidiSnapshot { notes:vec![PianoNote { pitch:60,start_time:0.125,end_time:1.875,velocity:87.0,confidence:None,channel:Some(9),track:Some(2) }], tempo_bpm:Some(93.5),metadata:serde_json::json!({"tracks":[{"channel":9}]}) },
            destination:serde_json::json!({"id":"123","name":"Test MIDI"})
        }).unwrap()
    }
    fn reserve(lib: &Library, session: &MidiSession, book: &str) -> CreatedSketch {
        lib.begin_midi_import(BeginMidiImport { session_id:session.id.clone(),media_extension:"mp3".into(),media_mime:"audio/mpeg".into(),notebook_id:book.into(),canvas_x_ms:1500,canvas_y:80.0 }).unwrap()
    }
    fn complete_args(session: &MidiSession) -> CompleteMidiImport {
        CompleteMidiImport { session_id:session.id.clone(),duration_ms:3000,original_filename:"Returned.mp3".into(),summary:Some(serde_json::json!({"noteCount":1})),metadata:serde_json::json!({"mode":"external"}) }
    }
    #[test]
    fn snapshots_survive_source_edits_deletion_and_restart() {
        let temp = tempfile::tempdir().unwrap(); let lib = Library::open(temp.path()).unwrap();
        let (id,_) = source(&lib); let saved = session(&lib,&id); let second = session(&lib,&id);
        lib.delete_sketch(&id).unwrap(); drop(lib);
        let lib = Library::open(temp.path()).unwrap();
        let reopened = lib.midi_session(&saved.id).unwrap();
        assert_eq!(reopened.snapshot.notes[0].start_time,0.125);
        assert_eq!(reopened.snapshot.notes[0].channel,Some(9));
        assert_eq!(reopened.midi_hash,saved.midi_hash);
        assert_eq!(lib.midi_sessions().unwrap().len(),2);
        assert_ne!(saved.id,second.id);
        assert!(lib.midi_session_bytes(&saved.id).unwrap().starts_with(b"MThd"));
    }
    #[test]
    fn completion_preserves_audio_notes_provenance_and_is_idempotent() {
        let temp = tempfile::tempdir().unwrap(); let lib = Library::open(temp.path()).unwrap();
        let (id,book) = source(&lib); let saved = session(&lib,&id); let import = reserve(&lib,&saved,&book);
        assert!(lib.complete_midi_import(complete_args(&saved)).is_err());
        lib.write_file(&import.id,FileKind::MediaChunk,b"unchanged MP3 bytes").unwrap();
        lib.write_file(&import.id,FileKind::Analysis,&[0;46]).unwrap();
        let result = lib.complete_midi_import(complete_args(&saved)).unwrap();
        assert_eq!(result.sketch.transcription_status,TranscriptionStatus::Done);
        assert_eq!(result.transcription.as_ref().unwrap().original_notes,saved.snapshot.notes);
        assert_eq!(fs::read(result.sketch.media_path.unwrap()).unwrap(),b"unchanged MP3 bytes");
        assert_eq!(lib.complete_midi_import(complete_args(&saved)).unwrap().sketch.id,import.id);
        assert_eq!(lib.midi_session(&saved.id).unwrap().status,"completed");
        assert!(lib.begin_midi_import(BeginMidiImport { session_id:saved.id.clone(),media_extension:"wav".into(),media_mime:"audio/wav".into(),notebook_id:book,canvas_x_ms:0,canvas_y:0.0 }).is_err());
        assert!(lib.set_midi_session_status(&saved.id,"pending").is_err());
        let bundle = lib.prepare_export(&import.id,"Returned",&[ExportKind::Recording,ExportKind::Midi,ExportKind::OriginalMidi]).unwrap();
        assert_eq!(bundle.files.len(),3);
        lib.set_midi_offset(&import.id,123.5).unwrap(); drop(lib);
        let lib = Library::open(temp.path()).unwrap();
        assert_eq!(lib.get(&import.id).unwrap().sketch.audio_midi_offset_ms,123.5);
        assert_eq!(lib.get(&import.id).unwrap().transcription.unwrap().original_notes,saved.snapshot.notes);
        assert!(lib.set_midi_offset(&import.id,f64::NAN).is_err());
    }
    #[test]
    fn interrupted_imports_are_not_transcribed_or_promoted_to_recordings() {
        let temp = tempfile::tempdir().unwrap(); let lib = Library::open(temp.path()).unwrap();
        let (id,book) = source(&lib); let saved = session(&lib,&id); let import = reserve(&lib,&saved,&book);
        lib.write_file(&import.id,FileKind::MediaChunk,b"partial audio").unwrap(); drop(lib);
        let lib = Library::open(temp.path()).unwrap(); let report = lib.recover().unwrap();
        assert!(report.recovered.is_empty()); assert!(lib.get(&import.id).is_err());
        assert_eq!(lib.midi_session(&saved.id).unwrap().status,"pending");
        assert!(lib.midi_session_bytes(&saved.id).is_ok());
        reserve(&lib,&saved,&book); // retry is possible
        lib.set_midi_session_status(&saved.id,"cancelled").unwrap();
        assert_eq!(lib.midi_session(&saved.id).unwrap().status,"cancelled");
        lib.set_midi_session_status(&saved.id,"pending").unwrap();
        lib.set_midi_session_status(&saved.id,"archived").unwrap();
    }
    #[test]
    fn original_file_is_write_once() {
        let temp = tempfile::tempdir().unwrap(); let lib = Library::open(temp.path()).unwrap();
        let (id,_) = source(&lib);
        lib.write_file(&id,FileKind::OriginalMidi,b"original").unwrap();
        assert!(lib.write_file(&id,FileKind::OriginalMidi,b"replacement").is_err());
        assert_eq!(fs::read(lib.sketch_dir(&id).join("original.mid")).unwrap(),b"original");
    }
}
