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
