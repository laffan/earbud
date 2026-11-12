# Architecture

Earbud is split into five parts with narrow interfaces between them, so that
platform code and AI models can be replaced independently.

```
┌──────────────────────────── UI (Svelte) ────────────────────────────┐
│ Home · Recorder overlay · Sketch view · Piano roll · Settings       │
└──────┬───────────────────────┬──────────────────────┬───────────────┘
       │ app state / capture flow (src/lib/state)     │
┌──────▼──────────┐  ┌─────────▼─────────┐  ┌─────────▼────────────────┐
│ Capture Engine  │  │ Processing queue  │  │ Music Engine             │
│ src/lib/capture │  │ src/lib/pipeline  │  │ src/lib/music            │
│  ├ native (iOS) │  │ audio → notes →   │  │ chords · MIDI · summary  │
│  └ web          │  │ chords → MIDI     │  │ synth · note helpers     │
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
- Sensitivity presets (Settings) map to onset/frame thresholds and the minimum note length.

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
- `synth.ts`: Web Audio piano-ish voice. `NoteSynth` plays notes in sync with the `<video>` clock with look-ahead
  scheduling. It anchors only once the audio clock is running, schedules from its own smooth clock, ignores
  disagreements with the video clock under 0.3 s (coarse or jittery media clocks), reschedules immediately on jumps
  over 1 s (seeks) and only after 0.25 s of persistent drift otherwise. Rescheduling on every small disagreement made
  a freshly created context retrigger the same note when switching to *Notes* mid-playback.
  `renderNotesToWav` renders the same voice in an `OfflineAudioContext` for the *Notes audio* export.
- `notes.ts`: naming, normalization (used by the editor), ranges.

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
  resize, double-tap to add, keyboard editing). It follows the playhead, lights sounding notes and keys, and draws
  a chord lane.
- `SwipeRow.svelte`: list row gestures. A horizontal drag reveals *Share* / *Delete*; vertical drags stay with the
  browser (`touch-action: pan-y`) so the list scrolls natively. A 500 ms press (or right-click) enters selection mode.
- `Waveform.svelte`: overview of the take drawn from peaks of the analysis WAV (`src/lib/audio/peaks.ts`, cached per
  file). Tap or drag to scrub; uses `fastSeek` while dragging. The shaded band is the piano roll's visible window.
- `SketchView.svelte`: piano roll first, then chords, waveform and transport, then the video. The layout is a single
  `minmax(0, 1fr)` grid column so wide children (the chord strip) scroll inside themselves instead of widening the
  page. Playback uses a source fallback chain (`asset://` URL → in-memory blob for files under
  200 MB → extracted analysis audio), the listen mode (take / synthesized notes / both), playback rate, the
  editing toolbar with undo/redo and debounced autosave, notes and export.

## 6. Playback transport (`src/lib/playback/transport.ts`)

One `MediaTransport` owns "where are we, are we playing" for the video, waveform, piano roll and synth:

- **Position is authoritative in the UI.** While scrubbing, the playhead follows the finger and the media follows
  with one seek in flight at a time, always to the latest target (exact seeks; no `fastSeek`, which lands on
  keyframes and made the views disagree).
- **Playing is re-derived from the element** on every media event. A source reload stops playback without a
  `pause` event; relying on play/pause events alone left the app showing *Pause* over a stopped video with a frozen
  playhead.
- **Aborted `play()` calls are retried**, not reported. A seek or reload rejects a pending play with AbortError,
  which had surfaced as a "Playback aborted" error toast.
- **The position survives a source reload** (e.g. the fallback from the `asset://` URL to an in-memory copy), and
  playback resumes.
- **Crop and loop.** Playback is limited to the sketch's crop range (stored as `crop_start_ms` / `crop_end_ms`,
  schema v2). At the end it stops and returns to the crop start, or loops.
- Media events (errors with codes, stalls, aborts, reloads, retries) go to the diagnostics log in Settings.

`src/lib/playback/transport.test.ts` drives it with a fake media element: seek coalescing, play after scrub,
reload during playback, aborted play, crop stop/loop, and throttled animation frames.

## 7. Export (`src/lib/export`)

`prepareExports(ids, kinds)` handles one or many sketches. `kinds` is any of `recording` | `audio` | `notes-audio` | `midi`:

- `midi` and `notes-audio` are rendered from the current notes (edits included) and written into the sketch folder
  (`transcription.mid`, `notes-audio.wav`).
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
