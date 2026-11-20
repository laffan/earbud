"""On a fresh simulator install, queue a saved take and check the default model’s MIDI."""
import json
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pretty_midi

device = sys.argv[1]
app = "com.earbud.sketchbook"


def simctl(*args):
    return subprocess.check_output(["xcrun", "simctl", *args], text=True).strip()


container = Path(simctl("get_app_container", device, app, "data"))
deadline = time.monotonic() + 90
while not (db_path := next(container.rglob("earbud.sqlite3"), None)):
    if time.monotonic() >= deadline:
        raise RuntimeError("Earbud did not initialize the sketch library")
    time.sleep(1)
simctl("terminate", device, app)
sketch = uuid.uuid4().hex
directory = db_path.parent / "sketches" / sketch
directory.mkdir()
subprocess.run(["node", "scripts/make-test-audio.mjs", str(directory / "recording.wav")], check=True)
with sqlite3.connect(db_path) as db:
    db.execute("""
        INSERT INTO sketches (id, title, created_at, updated_at, status, duration_ms,
            media_file, media_mime, has_video, capture_backend)
        VALUES (?, 'Dettato chords', 1, 1, 'saved', 7000, 'recording.wav', 'audio/wav', 0, 'import')
    """, (sketch,))
simctl("launch", device, app)
midi_path = directory / "transcription.mid"
deadline = time.monotonic() + 600
while not midi_path.is_file():
    with sqlite3.connect(db_path) as db:
        status, error = db.execute("SELECT transcription_status, transcription_error FROM sketches WHERE id=?",
                                   (sketch,)).fetchone()
    if status == "failed" or time.monotonic() >= deadline:
        raise RuntimeError(f"Simulator transcription {status}: {error}")
    time.sleep(2)
with sqlite3.connect(db_path) as db:
    engine, notes = db.execute("SELECT engine, original_notes_json FROM transcriptions WHERE sketch_id=?",
                               (sketch,)).fetchone()
expected = sorted([36, 60, 64, 67, 45, 57, 60, 64, 41, 57, 60, 65, 43, 55, 59, 62, 65])
assert engine == "basic-pitch", engine
pitches = sorted(n["pitch"] for n in json.loads(notes))
assert set(expected).issubset(pitches), pitches
midi = pretty_midi.PrettyMIDI(str(midi_path))
assert sorted(n.pitch for track in midi.instruments for n in track.notes) == pitches
print("Default Basic Pitch transcribed the expected pitches and wrote matching MIDI on the simulator.")
