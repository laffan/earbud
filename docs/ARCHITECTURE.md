# Architecture

Earbud is split into five parts with narrow interfaces between them, so that
platform code and AI models can be replaced independently.

```
┌──────────────────────────── UI (Svelte) ────────────────────────────┐
│ Home · Recorder · Sketch view (tracks, Chords) · Settings           │
└──────┬───────────────────────┬──────────────────────┬───────────────┘
       │ app state / capture flow (src/lib/state)     │
┌──────▼──────────┐  ┌─────────▼─────────┐  ┌─────────▼────────────────┐
│ Capture Engine  │  │ Processing queue  │  │ Music Engine             │
│ src/lib/capture │  │ src/lib/pipeline  │  │ src/lib/music            │
│  ├ native (iOS) │  │ audio → notes →   │  │ chords · key · voicings  │
│  └ web          │  │ chords → MIDI     │  │ MIDI · summary · synth   │
└──────┬──────────┘  └──┬──────────────┬─┘  └──────────────────────────┘
       │                │              │
┌──────▼──────────┐  ┌──▼────────────┐ │   ┌───────────────────────────┐
│ tauri-plugin-   │  │ Transcription │ └──►│ Sketch Library            │
│ capture (Swift) │  │ Engine        │     │ src/lib/library (client)  │
│ AVFoundation    │  │ Basic Pitch   │     │ src-tauri (Rust, SQLite,  │
│                 │  │ in a Worker   │     │ filesystem)               │
└─────────────────┘  └───────────────┘     └───────────────────────────┘
```

## 1. Capture Engine (`src/lib/capture`, `plugins/tauri-plugin-capture`)

Contract: `CaptureEngine` in `src/lib/capture/types.ts`.

| Backend | Where | How |
| --- | --- | --- |
| `NativeCaptureEngine` (`ios-avfoundation`) | iOS | Swift plugin: `AVCaptureSession` + `AVCaptureMovieFileOutput` → `.mov` written straight into the sketch folder |
| `WebCaptureEngine` (`web-mediarecorder`) | desktop, browser | `getUserMedia` + `MediaRecorder`, chunks streamed to disk every second over raw-byte IPC |

The backend is chosen at startup from `plugin:capture|capabilities` (implemented in Rust on every platform, so
the answer never depends on the Swift side being reachable).

Design rules:

- **No continuous frames over the bridge.** On iOS the preview is a native layer behind a transparent webview;
  JS gets only ~10 small events per second (level meter) through a Tauri `Channel`.
- **One clock.** Audio and video come from one capture session and one muxer, so they are synchronized by
  construction rather than aligned afterwards.
- **Write-ahead reservation.** `create_sketch` inserts a `recording` row and creates the folder *before* capture
  starts. If the app dies mid-take, `recover_sketches` on the next launch keeps whatever media reached disk.
- **Recording never depends on transcription.** The capture flow finishes (`finalize_sketch`) before anything is
  queued for analysis.
- **Count-in after the recorder starts.** Starting a camera can take a moment, so the three-beat count-in
  (`src/lib/capture/countIn.ts`) runs once the recorder is going, and the take keeps it at its start. The
  downbeat's position in the recording (`count_in_ms`) is taken from the recorder's own clock (the elapsed time in
  its level events) and stored with the take. The ticks are 25 ms bursts of filtered noise: unpitched and far
  shorter than Basic Pitch's minimum note length, so the microphone hearing them does not add notes. The audio
  context is created inside the tap that starts recording (iOS only starts audio during a gesture); without it the
  count-in is visual only. Stopping during the count-in discards the take.

Native-only extra: `extractAnalysisAudio` decodes the recording's audio to a 22.05 kHz mono WAV with
`AVAssetReader`. Backends without it fall back to Web Audio `decodeAudioData` plus a windowed-sinc resampler
(`src/lib/audio`).

## 2. Transcription Engine (`src/lib/transcription`)

The contract required by the brief, plus optional extras that do not break it:

```ts
interface PianoNote {
  pitch: number;      // MIDI
  startTime: number;  // seconds
  endTime: number;
  velocity: number;   // 0–127
  confidence?: number;
}

interface TranscriptionEngine {
  readonly id: string;            // stored with results, e.g. "basic-pitch"
  readonly version: string;
  readonly params: Record<string, unknown>;
  transcribe(audioPath: string, options?: { onProgress?; signal? }): Promise<PianoNote[]>;
}
```

`audioPath` is the derived analysis WAV on disk. The UI never imports a concrete model. `getTranscriptionEngine()`
in `src/lib/transcription/index.ts` is the single place that picks one.

**Basic Pitch implementation**

- `basicPitchCore.ts`: environment-agnostic runner over `@spotify/basic-pitch` (TF.js 4). It reimplements the
  windowing loop of `BasicPitch.evaluateModel` with per-window tensor disposal (the upstream loop keeps every
  intermediate tensor alive, which exhausts GPU memory on long takes) and cancellation between windows. Note
  creation uses upstream `outputToNotesPoly` / `noteFramesToTime`; velocity = 127 × mean activation (Basic Pitch's
  own MIDI mapping), and confidence = mean activation.
- `basicPitch.worker.ts`: runs the core in a Web Worker (WebGL via OffscreenCanvas, else CPU).
- `basicPitchEngine.ts`: worker client. If the worker cannot get WebGL but the page can (iOS < 17), it runs on the
  main thread with WebGL instead, because CPU inference would be several times slower.
- The model (`model.json` + one 742 KB weight shard) is copied from `node_modules` into `public/models/` at install
  time and loaded from the app bundle, so nothing is fetched from the network.
- `noteCleanup.ts` runs after Basic Pitch's own decoding (`outputToNotesPoly`), on its frame indices:
  - **Held notes.** A note held under other notes loses frame activation (masking) and comes back as separate
    notes. A later note of the same pitch within `joinMaxGapMs` is joined to the earlier one unless it is a new
    strike: onset activation ≥ `restrikeOnset` within ±2 frames of its start and, in *Join more*, frame
    activation ≥ `restrikeAttack` in its first ~140 ms (an octave struck above a held note produces an onset at
    the held pitch but no attack).
  - **Background sounds.** `dropUnstruck` removes notes whose start has no onset ≥ `strikeOnset` (voices and hum
    swell in). The level gate (`noiseGateDb`) measures each note in the analysis audio (Goertzel on its first
    three partials, about a semitone wide, during the attack) and drops notes that many dB below the 80th
    percentile of struck notes, so it adapts to how loud the take is.
- `settings.ts` maps the user's choices (environment *quiet* / *room* / *noisy* / *custom*, held notes *off* /
  *join* / *strong*) to those parameters. They are stored with each transcription (`params.environment`,
  `params.heldNotes`) and shown under the sketch's details.
- Engines for different settings share one runner (worker + loaded model). The runner keeps the last take's
  activations and audio (`TakeCache`, takes up to 5 minutes, keyed by the analysis WAV path and its length), so
  *Transcribe again* with other settings only repeats the decoding.
- Tests: `noteCleanup.test.ts` covers the rules on painted activations and on activations recorded from the
  model for a held note under chords and for repeated notes (`fixtures/`), so joining is checked against what
  the model really outputs.

**Adding another engine** (e.g. a newer piano-specific model): implement `TranscriptionEngine`, return it from
`getTranscriptionEngine`, and bump `id`/`version`. Stored transcriptions record which engine produced them.

**Native Core ML backend (deferred).** If WebGL inference is too slow on device, add a `transcribeNative`
command to the Swift plugin that runs Basic Pitch's Core ML export (`nmp.mlpackage` from the Python package)
on the analysis WAV. Return either finished notes or the raw `frames`/`onsets` matrices, written to a binary
file next to the recording, and feed them to the existing `notesFromModelOutput` so note creation stays
identical. Expose it as `NativeCoreMLEngine implements TranscriptionEngine`.

## 3. Music Engine (`src/lib/music`)

Pure TypeScript, no UI or platform dependencies, unit tested.

- `chords.ts`: chord identification. Time is split at onset clusters (notes within 70 ms count as one strike).
  Each span gets a 12-bin pitch-class profile weighted by sounding time, velocity, engine confidence and attack.
  Templates for 19 chord qualities come from tonal's `ChordType` dictionary and are scored for how much of the
  profile they explain and how complete they are, with small priors for simpler chords and root-position bass. A
  window keeps growing while its chord still explains the music and no new three-note chord is struck, so melody
  over a held chord does not fragment it. Results below a confidence threshold are not shown.
- `midi.ts`: Standard MIDI File export via `@tonejs/midi`.
- `summary.ts`: per-sketch digest (note count, chord progression, pitch range, ≤240 preview notes) stored in
  SQLite so the list can draw mini piano rolls without loading every note.
- `synth.ts`: Web Audio piano-ish voice. `NoteSynth` plays notes in step with playback by following the playback
  engine's clock mapping (`cue(mapping)`, then `pump()` every frame) on the engine's own audio context, so notes and
  recordings share one clock and need no drift correction. A mapping that takes over in the future (the next pass of
  a loop) lets the notes before the switch play out; notes never start past the pass's end (`until`). At most 48
  voices sound at once (the oldest fades out), so dense passages from several tracks cannot overload the audio
  thread. `renderNotesToWav` renders the same voice in an `OfflineAudioContext` for the *Notes audio* export.
  WebKit (Safari, the iOS and macOS web views) only lets an audio context start inside a user gesture and leaves
  `resume()` pending outside one, so the taps that lead to sound call `unlock()` synchronously.
- `key.ts`: key finding (Krumhansl–Schmuckler). A pitch-class profile of the notes, each weighted by how long it
  sounds (capped at 2 s, so a pedal tone does not swamp the rest), its loudness and the engine's confidence, is
  correlated with the Krumhansl–Kessler major and minor profiles for all 24 keys. A runner-up within 0.08
  correlation is reported as an alternative (usually the relative major or minor). Also roman numerals in a key
  (♭ for roots outside the scale; in minor, ♯ for the raised third and sixth and a plain vii for the leading tone),
  chord spelling with the key's sharps or flats, and chord names in words.
- `voicings.ts`: how to play a chord. Piano: the bass (root, or the slash chord's bass) in the left hand, the chord
  tones in root position in the right hand, rooted between G3 and F♯4. Guitar (standard tuning): searched rather
  than looked up, so all 19 qualities × 12 roots and any bass get shapes. For each position up the neck, each
  string is muted, open (near the nut) or fretted on a chord tone within a four-fret span. A shape is kept when its
  lowest note is the bass, it has every chord tone (a four- or five-note chord may leave out its fifth), at least
  four strings sound with no muted string between them (and no open string between fretted ones past the third
  fret), it needs at most four fingers (a barre counts as one), and no two fingers on one fret straddle a finger
  further up the neck. Shapes are ranked by position, fingers, muted strings, open strings and stretch. The usual
  open shapes (C, G, D, A, E, Am, Em, Dm, G7, E7, Am7, Cmaj7, C/E, C/G) and barre chords (F, Bm, B♭, F♯m) come out
  first (`voicings.test.ts`); up to three alternatives further up the neck are offered. About 1 ms per chord, cached.
- `notes.ts`: naming, normalization (used by the editor), ranges.
- `tempo.ts`: tempo and beat from notes. Note starts within 50 ms are one onset, weighted by loudness and count.
  Candidate beat periods (50–200 BPM) come from the autocorrelation of a 10 ms onset-strength signal, supported by
  the repeat at twice the period and weighted towards moderate tempos (log-normal around 100 BPM, 0.9 octaves wide)
  against double / half errors. Tempo (±4 %) and phase are then searched together for the grid the onsets fit best
  (on beats fully, on half beats half). Confidence is the share of onset weight within 45 ms of a beat or half beat,
  rescaled so that randomly placed notes score about 0: steady synthesized playing scores about 1, random notes
  0.2–0.3, and under 0.5 counts as no tempo.

## 4. Sketch Library (`src-tauri/src/library`, `src/lib/library`)

Rust owns storage. The frontend talks to it through typed commands (`src-tauri/src/commands.rs`); the TS mirror is
`src/lib/library/types.ts`.

```
<app data>/library/
  earbud.sqlite3                 WAL mode, migrations via PRAGMA user_version
  sketches/<32-hex id>/
    recording.<mov|mp4|webm|…>   original capture — immutable once saved
    analysis.wav                 derived audio for transcription (re-creatable)
    transcription.mid            current notes as MIDI (re-creatable)
    take-audio.m4a|wav           the take's audio track, written on share (re-creatable)
    notes-audio.wav              the notes rendered by the synth, written on share (re-creatable)
    exports/                     friendly-named hard links for sharing
```

Tables:

- `sketches`: title, timestamps, recording status (`recording` | `saved`), duration, media info, free-text notes,
  transcription status (`pending` | `running` | `done` | `failed`) and error, capture backend, recovery flag.
- `transcriptions`: engine id, version and parameters; `original_notes_json` (engine output, never overwritten by
  edits); `edited_notes_json` (user corrections, nullable); `summary_json`.
- `tracks` (schema v3): a sketch's tracks in order (`position`), each with a name, mute, solo, collapsed, and
  `take_id`, the take it plays.
- Tempo (schema v4, on the sketch row): `tempo_bpm`, `beat_ms` (where one beat falls on the timeline) and
  `tempo_source`: `count-in` (set when a new sketch is recorded with a count-in: its tempo, a beat on the
  downbeat), `detected` (by `tempo.ts` from the first recording's notes after each transcription of it, replacing
  `count-in` when confident) or `user` (never replaced). Sketches from before v4 get a detected tempo when opened.

**Tracks and takes.** Every recording is a `sketches` row with its own folder, media, analysis audio and
transcription, so capture, the processing queue, editing and export work on a take exactly as on a sketch. A
sketch is a row without `parent_id`; it is also the first take of its first track. Further takes have
`parent_id` (the sketch) and `track_id`, and `offset_ms`, where their time 0 lies on the sketch's timeline
(negative when the recording started before it, during its count-in). `create_sketch` with a `parentId` reserves
a take: with a `trackId` for that track (it starts playing once finalized, the earlier takes stay), without one
on a new track (created at once, so a crash mid-take is recovered into it). `delete_take` makes the track play its
latest other take and removes a track left empty; `delete_track` removes a track with its takes. The sketch's own
recording and the track holding it cannot be deleted on their own (that is deleting the sketch), which keeps every
sketch row backed by a recording. `list_sketches` returns takes too (the queue needs them); the home list shows
rows without a parent. Migration v3 gives every existing sketch one track named *Track 1*.

**Imported tracks** (`src/lib/library/importTrack.ts`) use the same calls as a recording: a take reserved on a new
track (capture backend `import`), the file uploaded in 4 MB `media-chunk`s, finalize, then the track renamed after
the file; a failure discards the take, which removes the new track. An audio file is kept untouched as the take's
recording and goes through the processing queue (on iOS through the native decoder first, like the app's own
recordings, then the webview's). A MIDI file is read with `midiFileToNotes` (every channel but percussion, times
from its tempo map) and is not transcribed: its notes are saved as the take's transcription (engine
`midi-import`), the synth renders them at 44.1 kHz as the take's recording and at 22.05 kHz as its analysis audio
(from which its waveform is drawn), and the file itself is kept as the take's `transcription.mid`.

Guarantees, enforced in Rust and covered by `cargo test`:

- The media file can only be appended to while the sketch is `recording`. After `finalize_sketch` nothing writes
  to it again; `discard_sketch` refuses saved sketches.
- Edits are stored beside the original transcription; *Revert* simply clears them. Re-transcribing replaces both
  (the UI asks first).
- Uploads carry only a sketch id and a file *kind* (`media-chunk` | `analysis` | `midi` | `notes-audio` |
  `take-audio`), never a path, and ids
  are validated as 32-hex strings, so the frontend cannot write outside a sketch folder.
- Binary uploads use Tauri's raw IPC body (no base64/JSON).
- Recovery on launch: interrupted recordings with data are kept (flagged *Recovered*), empty ones removed, and
  transcriptions left `running` go back to `pending` and are re-queued.

Outside Tauri (`npm run dev` in a browser), `MemoryLibrary` implements the same interface in memory with blob URLs,
which makes the whole UI testable in Chromium.

## 5. UI (`src/lib/ui`, `src/lib/state`)

- `state/app.svelte.ts`: a single reactive `app` object (Svelte 5 runes) with the capture flow
  (`startRecording` → permissions → `create_sketch` → engine start; `stopRecording` → `finalize_sketch` → queue),
  navigation (hash routes, so back gestures work), settings (localStorage) and toasts.
- `pipeline/processingQueue.ts`: one job at a time, paused while recording, and cancellable. Each job runs analysis
  audio, then `engine.transcribe`, then `summarize` + `save_transcription`, then the MIDI file. Failures only set
  `transcription_status = failed`.
- `PianoRoll.svelte`: canvas renderer and gesture handling (seek, pan, pinch/ctrl-wheel zoom, select, move,
  resize, double-tap to add, keyboard editing). It follows the playhead and lights sounding notes and keys (chord
  names are in the track's chord strip, not on the roll). In edit mode the selection is a list of note indices: a one-finger drag on empty space draws a
  selection rectangle (Shift adds; the view scrolls when the rectangle reaches an edge), dragging a selected note
  moves or resizes the whole selection rigidly, and panning moves to two fingers, the wheel and the time ruler.
  Group operations (`shiftNotes`, `joinNotes`) live in `src/lib/music/selection.ts`.
- `SwipeRow.svelte`: list row gestures. A horizontal drag reveals *Share* / *Delete*; vertical drags stay with the
  browser (`touch-action: pan-y`) so the list scrolls natively. A 500 ms press (or right-click) enters selection mode.
- `Waveform.svelte`: overview of the take drawn from peaks of the analysis WAV (`src/lib/audio/peaks.ts`, cached per
  file). Tap or drag to scrub. Outside the crop handles is dimmed; between them only the waveform is drawn.
- `Waveform.svelte`: draws on the sketch's timeline, so a take that starts later is drawn further right. Pressing
  and holding (350 ms without moving) opens a magnifier: a fixed-position canvas above the finger that draws the
  waveform about eight times closer from `Peaks.detail` (150 buckets per second) and follows the finger,
  including on the crop handles.
- `PianoRoll.svelte` details for tracks: notes are in their take's time and the view in sketch time (`offset`);
  rolls share a `RollViewport` (zoom, scroll, "user is scrolling") so all tracks stay lined up; `compact` draws a
  short strip of the notes (not used at the moment). While editing with a finger, a drag scrolls as in review (the canvas keeps
  `touch-action: pan-y`), and a press held for 300 ms turns the drag into a selection rectangle (on an unselected
  note, picks the note up); a non-passive `touchmove` listener stops the page from scrolling during those drags.
  A mouse drag selects at once.
- `TrackPanel.svelte`: one track. Title bar (collapse, name, take number, M / S / ● toggles, menu with the takes,
  transcribe again, revert, *Line up* nudge, delete). Expanded: the piano roll (the pencil in its top-left corner,
  the editing toolbar above it), the chord strip, then the waveform, as one block. Collapsed: the waveform only.
  Editing state (notes, selection, undo/redo, debounced autosave) lives here, per take.
- `ChordStrip.svelte`: a track's chords between its roll and its waveform. It scrolls and zooms with the roll (the
  shared `RollViewport`, with the same 40 px left margin as the roll's keyboard), so a chord sits under the notes
  that make it; a chord that began off to the left keeps its name in view. The chord at the playhead is lit; tap
  one to hear it (and, when stopped, to go there).
- `ChordsPanel.svelte`: the *Chords* section under the tracks. It analyses the notes of the tracks being heard (mute
  and solo apply) together on the sketch's timeline: `detectChords` on the merged notes (so a bass track and a
  chord track make one harmony) and `detectKey`. The header shows the key (with the alternative when it is close).
  Tab *Chords*: the progression as chips with roman numerals (tap: go there and hear it), then a card per chord
  used, in order of appearance, with its symbol, numeral, name in words, how often and how long it is played, and
  how to play it: a keyboard (`PianoDiagram.svelte`) or a guitar box (`GuitarDiagram.svelte`, with alternative
  shapes). The chord at the playhead is outlined; a card's play button plays the voicing shown. Tab *Circle of
  fifths* (`CircleOfFifths.svelte`): three rings (major outside, relative minor in the middle, the key's
  diminished chord inside, so each key's chords form a wedge), the key's wedge shaded and its tonic outlined, the
  chords used filled by how long they sound, the progression drawn as arrows, the chord at the playhead lit; any
  chord can be tapped to hear it. The tab and instrument are remembered in `localStorage`. Chord symbols are spelled
  for the key everywhere (the strips too).
- `SketchView.svelte`: the tracks, *Record track* / *Import track*, the *Chords* section, the video, text notes and
  details, and the transport fixed to the bottom. All sound goes through one `AudioEngine` (section 6): each take
  is decoded into a buffer as it appears (`takeBuffers.ts`); the video, the first take with video, is muted and
  follows the engine (`VideoFollower`; `TakeSource` gives it an in-memory copy when WebKit cannot seek the file
  URL). Also
  the listen mode (take / synthesized notes of the audible tracks / both), playback rate and crop. Recording into
  the sketch (*Record track*, or the armed track's record button) pauses playback, records with
  `app.startRecording({ take })`, and at the downbeat starts the other tracks from the playhead (not before the
  first track's downbeat, and on a beat when the sketch has a tempo); the take is placed with
  `offset = playFrom − downbeat`, where `playFrom` is the position heard at the downbeat (the start position minus
  the engine's 50 ms lead and the reported output latency). With a tempo, the count-in runs at it, and the recording screen flashes a dot on
  the sketch's beats (worked out at the downbeat; nothing audible). Crop, loop and slowed playback are off while
  recording.
  Listening is *Take*, *Notes*, *Both*, or, with several tracks, *Separate*: each track then has its own choice,
  so a track's recording is muted in the mixer when it plays notes only, and the synth plays the notes of the
  tracks set to *Notes* or *Both*.
- `TempoSheet.svelte`: the tempo editor (typed value, − / +, slider, tap tempo, *Detect again*, playback speed).
  While it is open and the sketch plays, `ClickTrack` (`src/lib/capture/countIn.ts`) ticks on the beat grid,
  scheduled ahead on the audio clock from a smooth mapping of media time, so the tempo can be matched by ear. A
  tempo changed by hand keeps the beat nearest the playhead in place; a tapped one puts a beat at the last tap.

## 6. Playback (`src/lib/playback`)

**Why Web Audio and not media elements.** Until this version each track played through its own `<audio>` /
`<video>` element, with one element as the clock and the others kept in step by changing their `playbackRate`
(with pitch correction on) and seeking them. On WebKit each element is its own AVFoundation player, and every rate
change or seek is an audible discontinuity; the summed output of several loud takes was not limited either. With
three or more tracks (and the synth, in *Separate*) this produced static, stopped playheads and crashes. In desktop
Chromium the old mixer stayed in step (4 tracks, also with 6× CPU throttling), so the failure was specific to
WebKit, where it could not be reproduced here; the redesign removes the mechanisms rather than tuning them.

`AudioEngine` (`audioEngine.ts`) plays every track from a decoded `AudioBuffer`, one buffer source per track,
scheduled against one `AudioContext` clock:

- **Sample-locked tracks.** A pass starts all sources at the same audio time (50 ms ahead of the clock), each at
  its place on the timeline (a track that starts later is scheduled later; one that began before time 0 starts
  inside its buffer). Nothing drifts, so nothing is corrected. Mute, solo and the listen mode only move a track's
  gain. A track whose buffer arrives while playing joins in step; one whose take or offset changes restarts alone.
- **One output, limited.** Tracks and the synth (which plays into `engine.input` on the same context) are summed
  through a limiter (threshold −2 dBFS, ratio 20), so several loud takes cannot clip.
- **Clock mapping.** A `ClockMapping` says which timeline position sounds at which audio time; the synth follows it
  exactly. The position reported to the UI is the one being heard: the audio clock minus `baseLatency` +
  `outputLatency` (up to 0.5 s).
- **Crop and loop.** Playback is limited to the sketch's crop range (stored as `crop_start_ms` / `crop_end_ms`).
  The end of a pass is scheduled 0.3 s before it: the sources stop exactly there (8 ms fade), and with loop on the
  next pass is scheduled to start at that same audio time, so loops are gapless. Without loop, playback stops and
  returns to the crop start (or stays at the end of the sketch).
- **Slowed playback** (0.75×, 0.5×) plays stretched copies of the buffers, made once per speed in a worker by WSOLA
  (`stretch.ts`: 25 ms Hann frames, 50 % overlap, each frame moved by up to ±10 ms to where its waveform best
  continues the previous one, searched on a 4× decimated signal and refined). This is the family of algorithm
  Chromium uses for `preservesPitch`; AVFoundation's own time-pitch (which WebKit used before) is spectral and
  likely smoother. Four 40 s tracks took about 0.6 s to prepare in desktop Chromium.
- **Waiting.** Play waits (shown as *loading…*) until at least one track is decoded and the audio context runs;
  WebKit only starts an audio context inside a tap, so the play and record buttons call `engine.unlock()`.

`takeBuffers.ts` decodes a take: on iOS, a take with video is read from its audio track written by AVFoundation
(`exportAudio` → `take-audio.m4a`, also used by export), so a video file is never read into memory; otherwise the
recording itself is decoded with `decodeAudioData` (files over 400 MB are not); the last resort is the 22.05 kHz
analysis WAV. Decoded buffers are cached by file for reopening sketches, up to about ten minutes of mono audio
(~115 MB; least recently used first out): an iOS web view is ended when it uses too much memory, and decoding
again is quick. `videoFollower.ts` keeps the muted video on the frame for the position: it starts and
pauses with playback, follows speed changes, seeks when the picture is more than 0.15 s off (at most once a
second), and parks it while paused. A video that stalls or drops a seek can only delay the picture.

`audioEngine.test.ts` drives the engine with a fake context: placement of tracks on the clock, heard position and
latency, mute without restart, seeks, tracks that finish decoding while playing, waiting for audio, crop stop,
gapless loop passes, stretched buffers, and WebKit's gesture-gated start. `stretch.test.ts` checks pitch, length,
level steadiness and timing. `npm run smoke:playback` checks the same in Chromium by recording every buffer source
the page starts.

## 7. Export (`src/lib/export`)

`prepareExports(ids, kinds)` handles one or many sketches. `kinds` is any of `recording` | `audio` | `notes-audio` | `midi`:

- `midi` and `notes-audio` are rendered from the current notes (edits included) and written into the sketch folder
  (`transcription.mid`, `notes-audio.wav`).
- A sketch with several tracks (or whose only track plays a later take): MIDI gets one MIDI track per track, notes
  moved onto the sketch's timeline; *notes audio* renders the audible tracks; *audio* mixes the audible tracks'
  recordings (each decoded at 44.1 kHz mono with Web Audio, or its analysis audio, placed at its offset, scaled
  down only if the sum would clip) into `take-audio.wav`; the *recording* is the take the sketch view shows.
  `prepare_export` picks whichever of `take-audio.m4a` / `.wav` is newer.
- `audio` is the take's sound on its own. On iOS it comes from the native `exportAudio` command (`take-audio.m4a`).
  Elsewhere it is decoded with Web Audio at full quality (`take-audio.wav`), falling back to the analysis WAV.
- Rust's `prepare_export(id, baseName, kinds)` then hard-links the chosen files into `exports/` under friendly
  names (`Title.mov`, `Title (audio).m4a`, `Title (notes).wav`, `Title.mid`) and reports kinds it could not find.
- `deliverExports` hands the files to the iOS share sheet, a desktop folder picker (with name de-duplication), or
  browser downloads.

## 8. Apple Watch link (`src-tauri/src/watch_link`, `plugins/tauri-plugin-watch-link`, `src/lib/watch`, `watch-app/`)

A second way in for recordings: the Watch app records AAC audio and sends it to one paired device
running Earbud. The protocol comes from Woods Whisper (5-digit pairing code → receiver name, stable
device id and secret); `watch-app/README.md` specifies it.

```
Watch (watch-app/EarbudWatch + Packages/EarbudLink)
   │ Wi-Fi (TCP 50720)          │ Bluetooth LE            │ WatchConnectivity
   ▼                            ▼                         ▼
src-tauri/src/watch_link    tauri-plugin-watch-link (Swift, iOS only)
 server.rs (std::net)        BluetoothReceiver · PhoneSessionLink
   │                            │                         │
   └──────────► library/inbox/<id>.m4a + <id>.json ◄──────┘
                         │ WatchLink::import_inbox
                         ▼
                Library::import_recording → sketch (capture backend "apple-watch")
                         │ "watch-link" event / import_watch_inbox
                         ▼
                src/lib/watch/receiver.svelte.ts → AppState.addReceived → processing queue
```

- **Identity** (name, device id, secret, paired watches) lives in Rust (`library/watch-link.json`). The
  iOS plugin is (re)started with it whenever it changes, so every transport answers with the same name and
  id and checks the same secret.
- **The inbox** decouples transports from the library: Swift writes files, Rust imports them. A sidecar
  written last marks an entry complete. The sketch id is the recording's UUID, so duplicates collapse.
- **Transcription** of Watch recordings goes through the usual queue. On iOS the native extractor
  (AVAssetReader) decodes the `.m4a`; elsewhere, or if that fails, the webview's decoder does.
- `WatchLinkClient` (`src/lib/watch/types.ts`) is the seam for tests: `receiver.test.ts` drives the
  receiver with a fake client. The Rust tests run pairing and transfers over real sockets and decode the
  same JSON fixtures as the Swift package's tests.

## Platform isolation

| Concern | iOS | Desktop | Browser (dev) |
| --- | --- | --- | --- |
| Capture | Swift plugin | MediaRecorder | MediaRecorder |
| Analysis audio | AVAssetReader | Web Audio decode | Web Audio decode |
| Storage | Rust + SQLite | Rust + SQLite | in memory |
| Share/export | `UIActivityViewController` | folder picker + copy | download |
| Transcription | Basic Pitch (worker, WebGL) | same | same |

Everything platform-specific sits behind `CaptureEngine`, `SketchLibrary` or `src/lib/platform/tauri.ts`.

## Future: visual key and finger tracking

`src/lib/vision/types.ts` defines `VisualAnalysisEngine` (video → `KeyboardObservation[]`) and `FusionEngine`
(audio notes + observations → notes with hand/finger). On iOS the plan is a native `analyzeVideo` command that
reads the saved `.mov` with `AVAssetReader`, runs Apple Vision (`VNDetectHumanHandPoseRequest` plus keyboard
geometry) on-device, and writes a compact JSON result next to the recording. This follows the same pattern as
`extractAnalysisAudio`. Because the original video is kept untouched and every transcription records its engine,
fused results can be added later and compared with audio-only ones. The 720p capture preset leaves enough
resolution for hand pose while keeping files small.

## Future: cloud processing

A remote engine would be another `TranscriptionEngine` that uploads `analysis.wav` (small: ~2.6 MB/min) and
returns `PianoNote[]`. Because results record `engine`/`version`/`params`, local and remote transcriptions can
coexist. Nothing in the capture or storage path assumes a network.
