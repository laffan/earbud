//! SQLite schema and forward-only migrations keyed on `PRAGMA user_version`.

use rusqlite::Connection;

/// Each entry upgrades the schema from version `index` to `index + 1`.
const MIGRATIONS: &[&str] = &[
    // v1: sketches + transcriptions
    r#"
    CREATE TABLE sketches (
        id                   TEXT PRIMARY KEY NOT NULL,
        title                TEXT NOT NULL DEFAULT '',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        status               TEXT NOT NULL,
        duration_ms          INTEGER,
        media_file           TEXT,
        media_mime           TEXT,
        has_video            INTEGER NOT NULL DEFAULT 1,
        video_width          INTEGER,
        video_height         INTEGER,
        text_notes           TEXT NOT NULL DEFAULT '',
        transcription_status TEXT NOT NULL DEFAULT 'pending',
        transcription_error  TEXT,
        capture_backend      TEXT NOT NULL DEFAULT '',
        recovered            INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX sketches_created_at ON sketches(created_at DESC);

    CREATE TABLE transcriptions (
        sketch_id           TEXT PRIMARY KEY NOT NULL
                            REFERENCES sketches(id) ON DELETE CASCADE,
        engine              TEXT NOT NULL,
        engine_version      TEXT NOT NULL,
        params_json         TEXT NOT NULL,
        original_notes_json TEXT NOT NULL,
        edited_notes_json   TEXT,
        summary_json        TEXT,
        created_at          INTEGER NOT NULL,
        edited_at           INTEGER
    );
    "#,
    // v2: playback crop range (milliseconds; NULL = whole take). Playback
    // only: the recording is never trimmed.
    r#"
    ALTER TABLE sketches ADD COLUMN crop_start_ms INTEGER;
    ALTER TABLE sketches ADD COLUMN crop_end_ms INTEGER;
    "#,
    // v3: tracks. A sketch (a row with no parent) holds one or more tracks;
    // each track has one or more takes (recordings) and plays one of them.
    // Every take is a `sketches` row of its own, so recordings, analysis
    // audio and transcriptions work the same for every take. The sketch's
    // own row is the first take of its first track.
    r#"
    ALTER TABLE sketches ADD COLUMN parent_id TEXT;
    ALTER TABLE sketches ADD COLUMN track_id TEXT;
    ALTER TABLE sketches ADD COLUMN offset_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sketches ADD COLUMN count_in_ms INTEGER;
    CREATE INDEX sketches_parent ON sketches(parent_id);
    CREATE INDEX sketches_track ON sketches(track_id);

    CREATE TABLE tracks (
        id         TEXT PRIMARY KEY NOT NULL,
        sketch_id  TEXT NOT NULL REFERENCES sketches(id) ON DELETE CASCADE,
        position   INTEGER NOT NULL,
        name       TEXT NOT NULL DEFAULT '',
        take_id    TEXT NOT NULL,
        muted      INTEGER NOT NULL DEFAULT 0,
        solo       INTEGER NOT NULL DEFAULT 0,
        collapsed  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX tracks_sketch ON tracks(sketch_id, position);

    INSERT INTO tracks (id, sketch_id, position, name, take_id, created_at)
        SELECT lower(hex(randomblob(16))), id, 0, 'Track 1', id, created_at FROM sketches;
    UPDATE sketches SET track_id = (SELECT t.id FROM tracks t WHERE t.take_id = sketches.id);
    "#,
    // v4: the sketch's tempo (beats per minute), where one of its beats falls
    // on the timeline (ms), and where the tempo came from: 'detected' from the
    // first recording's notes, the 'count-in' it was recorded with, or 'user'.
    r#"
    ALTER TABLE sketches ADD COLUMN tempo_bpm REAL;
    ALTER TABLE sketches ADD COLUMN beat_ms INTEGER;
    ALTER TABLE sketches ADD COLUMN tempo_source TEXT;
    "#,
    // v5: notebooks. A notebook is a canvas on which sketches are placed:
    // `canvas_x_ms` is where the sketch's recording (time 0) lies on the
    // notebook's timeline, `canvas_y` how far down the canvas it sits (free
    // placement, canvas pixels). The playhead plays every sketch it crosses.
    // `kind` is 'audio' (a recording) or 'rhythm' (a step pattern in
    // `rhythm_json`, rendered when played; no media file). The notebook's
    // loop range is where repeat plays (NULL = from the first sketch to the
    // end of the last).
    r#"
    CREATE TABLE notebooks (
        id            TEXT PRIMARY KEY NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        loop_start_ms INTEGER,
        loop_end_ms   INTEGER
    );
    ALTER TABLE sketches ADD COLUMN notebook_id TEXT;
    ALTER TABLE sketches ADD COLUMN canvas_x_ms INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sketches ADD COLUMN canvas_y REAL NOT NULL DEFAULT 0;
    ALTER TABLE sketches ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio';
    ALTER TABLE sketches ADD COLUMN rhythm_json TEXT;
    CREATE INDEX sketches_notebook ON sketches(notebook_id);
    "#,
    // v6: how many times a recording plays in a row on the canvas (its
    // playing part repeated, dragged out by its right edge). Rhythms repeat
    // by bars in their pattern instead.
    r#"
    ALTER TABLE sketches ADD COLUMN canvas_repeats INTEGER NOT NULL DEFAULT 1;
    "#,
    // v7: text notes on the canvas (kind 'text', the markdown in text_notes):
    // the box's width and minimum height in canvas pixels (NULL = fit the text).
    r#"
    ALTER TABLE sketches ADD COLUMN canvas_w REAL;
    ALTER TABLE sketches ADD COLUMN canvas_h REAL;
    "#,
    // v8: the playback source is a per-sketch preference, shared with the canvas.
    r#"
    ALTER TABLE sketches ADD COLUMN listen_mode TEXT NOT NULL DEFAULT 'recording'
        CHECK (listen_mode IN ('recording', 'notes', 'both'));
    "#,
    // v9: how loud a sketch plays on the canvas (0–1; 1 = as recorded).
    r#"
    ALTER TABLE sketches ADD COLUMN canvas_volume REAL NOT NULL DEFAULT 1
        CHECK (canvas_volume >= 0 AND canvas_volume <= 1);
    "#,
    // v10: the sample library. A sample is a short sound cut from a recording
    // (`samples/<id>/sample.wav`, written once) with its playback settings
    // (trim, envelope, effects, root note) as JSON, rendered when played. A
    // sketch can play its notes with one (`note_sample_id`); rhythms name the
    // samples their pads play inside their pattern.
    r#"
    CREATE TABLE samples (
        id               TEXT PRIMARY KEY NOT NULL,
        title            TEXT NOT NULL DEFAULT '',
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        duration_ms      INTEGER,
        source_sketch_id TEXT,
        source_start_ms  INTEGER,
        source_end_ms    INTEGER,
        settings_json    TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX samples_created_at ON samples(created_at);
    ALTER TABLE sketches ADD COLUMN note_sample_id TEXT;
    "#,
];

pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "foreign_keys", true)?;
    // WAL keeps the UI responsive while the processing queue writes results.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
