# Earbud — a musical sketchbook

Earbud is a small, offline-first app for capturing piano ideas. Tap **Record**,
play, tap **Stop**. Earbud keeps the original audio and video, transcribes the
notes and chords in the background, and files the sketch in a chronological
notebook. You can then replay the take next to an interactive piano roll,
correct the notes, add text notes, and export the recording and a MIDI file.

It is meant to feel like a notebook, not a digital audio workstation.

- **Capture first**: one tap, no setup screens. Permission prompts appear only the first time.
- **Offline**: recording, storage, transcription (Basic Pitch, bundled) and playback need no network.
- **Non-destructive**: the original recording is never modified. Engine output and your edits are stored separately.
- **Asynchronous**: transcription runs in a worker after the take is saved. A failed transcription never affects the recording.
- **Polyphonic**: two-handed playing, overlapping notes and chords.

Built with Tauri 2, Svelte 5 + TypeScript, Rust + SQLite, Swift + AVFoundation (iOS) and
[Spotify's basic-pitch-ts](https://github.com/spotify/basic-pitch-ts).

## Status

| Area | State |
| --- | --- |
| Home screen, one-tap record, chronological library | Done |
| iOS synchronized audio/video capture (AVFoundation) | Implemented. **Not yet run on a device**: see [docs/IOS.md](docs/IOS.md) |
| Desktop / browser capture (MediaRecorder) | Done, tested in Chromium |
| Local storage (SQLite + files), crash recovery | Done, unit tested |
| Offline Basic Pitch transcription | Done, tested on synthesized two-handed chords |
| Chord names, MIDI export | Done, unit tested |
| Piano roll, synchronized playback, note editing | Done, tested end to end in Chromium and in the Linux desktop app |
| Titles, text notes, export/share | Done |
| Core ML transcription backend, Apple Vision finger tracking, cloud processing | Deferred (interfaces in place) |

"Tested" means automated checks in this repository passed. The Swift code could not be compiled
here (no macOS/Xcode in the build environment), so the first iOS build may need small fixes.
[docs/IOS.md](docs/IOS.md) lists what to check on a device.

## Quick start

Prerequisites: Node.js 20+ and Rust (stable). For desktop builds, the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. For iOS: macOS with Xcode.

```bash
npm install
```

`npm install` also copies the Basic Pitch model from `node_modules` into `public/models/` so it is
bundled with the app.

### Browser preview (fastest UI iteration)

```bash
npm run dev
```

Open http://localhost:1420. Outside Tauri the app uses an in-memory sketch library and the
browser's camera and microphone. Sketches disappear on reload.

### Desktop app (macOS, Windows, Linux)

```bash
npm run tauri dev
```

Desktop capture uses the webview's camera/microphone. Only Linux was exercised here (with a scripted test,
not a real camera). On macOS the app asks for camera and microphone access through the usage strings in
`src-tauri/Info.plist`.

### iPhone / iPad

See **[docs/IOS.md](docs/IOS.md)** for one-time setup, permissions, signing and running on a physical device. In short:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
npm run tauri ios init
```

```bash
APPLE_DEVELOPMENT_TEAM=<your team id> npm run tauri ios dev -- --host
```

## Using Earbud

1. **Record**: prop the phone above the keys (back camera, or *Ultra wide* in Settings to fit the whole
   keyboard) and tap the red button. The screen stays awake while recording.
2. **Stop**: the take is saved immediately with a timestamp. Name it later if you like.
3. **Transcribe**: happens automatically. The card shows progress, then the chord progression.
4. **Review**: open a sketch to play the video with a piano roll that follows the playhead, a chord lane and
   lit keys. Choose *Take*, *Notes* (a synth plays the transcription) or *Both*, and slow down to 0.75× or 0.5×.
5. **Edit**: tap *Edit notes*. Tap a note to select it, drag to move it, drag its end to resize it, and
   double-tap to add one. The toolbar transposes, nudges, deletes and undoes. Edits save automatically and can
   be reverted to the original transcription.
6. **Export**: the share button exports the original recording and a `.mid` file (iOS share sheet, or a
   folder picker on desktop).

## Project layout

```
src/                         Svelte + TypeScript UI and engines
  lib/capture/               Capture Engine contract + native (iOS) and web backends
  lib/transcription/         TranscriptionEngine contract + Basic Pitch (worker)
  lib/music/                 Chords, MIDI, summaries, note helpers, playback synth
  lib/library/               Sketch Library client (Tauri) + in-memory dev backend
  lib/pipeline/              Background processing queue
  lib/vision/                Future visual analysis / fusion interfaces
  lib/state/                 App state and the capture flow
  lib/ui/                    Components (home, recorder, sketch view, piano roll…)
src-tauri/                   Rust app: Sketch Library (SQLite + files) and IPC commands
plugins/tauri-plugin-capture Native capture plugin (Swift/AVFoundation on iOS)
docs/                        Architecture and iOS guides
scripts/                     Model copy, test-audio generator, end-to-end smoke tests
```

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for module boundaries, data flow and extension points.

## Testing

```bash
npm test                             # Vitest: WAV/resampling, chords, MIDI, real Basic Pitch inference
npm run check                        # svelte-check / TypeScript
(cd src-tauri && cargo test)         # Sketch Library: storage, immutability, edits, recovery, export
```

End-to-end smoke tests (optional, need Playwright's Chromium or `tauri-driver`):

```bash
node scripts/make-test-audio.mjs /tmp/chords.wav
```

```bash
SMOKE_WAV=/tmp/chords.wav npm run smoke:browser   # with `npm run dev` running
```

`npm run smoke:tauri` drives the real desktop app (Rust, SQLite, IPC, asset protocol) through WebDriver on
Linux; the header of `scripts/tauri-webdriver-smoke.mjs` explains the setup.

## Known limitations

- **iOS is untested on hardware.** See the checklist in [docs/IOS.md](docs/IOS.md).
- **Transcription accuracy** is that of Basic Pitch: expect occasional ghost notes from strong harmonics,
  octave confusions, and approximate note ends with the sustain pedal down. Velocities are estimated from
  model activations, not measured. Low-confidence notes are drawn fainter.
- **Transcription speed**: in this repository's tests (software rendering, no GPU) a 6–7 second take took
  13–16 s to transcribe. GPU (WebGL) inference should be faster but has not been measured on an iPhone.
  Inference runs in a worker, with a main-thread WebGL fallback on iOS versions without WebGL in workers.
  If it is too slow on device, the engine interface allows a native Core ML backend (see the architecture doc).
- **Android** has no native capture backend yet. The web backend may work but has not been tested.
- **Linux desktop**: WebKitGTK cannot stream media from custom URL schemes, so playback falls back to loading
  the file into memory (fine for typical sketches). Camera and microphone access depend on the distribution's
  WebKitGTK build.
- **Background recording** is not supported: iOS stops the camera when the app leaves the foreground. The take
  up to that point is saved automatically.
- No notation, quantization or tempo detection yet. MIDI is exported in real time (120 BPM header).

## License

MIT for Earbud's own code. Basic Pitch (model and library) is Apache-2.0, © Spotify AB.
