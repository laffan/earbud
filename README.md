# Earbud — a musical sketchbook

Earbud is a small, offline-first app for capturing piano ideas. Tap **Record**,
play, tap **Stop**. Earbud keeps the original audio and video, transcribes the
notes and chords in the background, and files the sketch in a chronological
notebook. You can then replay the take next to an interactive piano roll,
correct the notes, layer more tracks over it, add text notes, and export the
recording and a MIDI file.

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
| iOS synchronized audio/video capture (AVFoundation) | Builds and runs on iPhone; start-up reliability fix pending confirmation on a device (see [docs/IOS.md](docs/IOS.md)) |
| Desktop / browser capture (MediaRecorder) | Done, tested in Chromium |
| Local storage (SQLite + files), crash recovery | Done, unit tested |
| Offline Basic Pitch transcription | Done, tested on synthesized two-handed chords |
| Chord names, MIDI export | Done, unit tested |
| Piano roll, synchronized playback, note editing | Done, tested end to end in Chromium and in the Linux desktop app |
| Tracks (layered recordings in one sketch), takes, mute/solo, count-in | Done, tested in Chromium (fake camera/microphone) and the Linux desktop app; not yet run on an iPhone |
| Titles, text notes, export/share | Done |
| Apple Watch companion: record on the Watch, send to a paired device | Written; receiver tested over TCP, Watch and iOS Swift not yet compiled (see [watch-app/README.md](watch-app/README.md)) |
| Core ML transcription backend, Apple Vision finger tracking, cloud processing | Deferred (interfaces in place) |

"Tested" means automated checks in this repository passed. The Swift code (iOS plugins, Watch app) could not
be compiled here (no macOS/Xcode in the build environment), so the first build may need small fixes.
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
browser's camera and microphone. Sketches disappear on reload. Open http://localhost:1420/?demo to start with a
40-second demo sketch (rendered with the built-in synth) for working on the UI without recording.

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
   keyboard) and tap the red button. After a count-in of three ticks (with 3-2-1 on screen) the take begins.
   The screen stays awake while recording. Stopping during the count-in cancels the take. Settings →
   *Count-in* sets the tempo or turns it off.
2. **Stop**: the take is saved immediately with a timestamp. Name it later if you like.
3. **Transcribe**: happens automatically. The card shows progress, then the chord progression. Settings →
   *Transcription* says what kind of room you record in (*Quiet*, *Normal*, *Noisy* or *Custom*) and whether
   held notes are joined; see [Transcription settings](#transcription-settings).
4. **Review**: open a sketch. Each track is a piano roll (scroll it sideways, pinch to zoom; it follows the
   playhead, lights the sounding keys and names the chords along the top, which you can tap to hear) with
   the waveform of its take attached underneath (tap or drag to scrub; **press and hold** to open a magnifier
   that shows the waveform close up and follows your finger). The video and your notes come after the tracks.
   The transport stays at the bottom of the screen: play, the time, *Take*, *Notes* (a synth plays the
   transcription) or *Both*, loop, and the speed (0.75× or 0.5×).
   Drag the bracket handles at either end of a waveform to **crop playback** to a passage (saved with the
   sketch; the recording itself is not trimmed), and turn on **loop** to repeat it.
5. **Edit**: tap the pencil in the top-left corner of a piano roll. Tap a note to select it. A one-finger drag
   still scrolls; **press and hold, then drag** to draw a rectangle that selects every note it touches (on a
   note, press and hold picks the note up). With a mouse, drag across the roll to select (Shift adds,
   Cmd/Ctrl+A selects all). Drag a selected note to move the whole selection, drag its end to resize, and
   double-tap to add a note. The toolbar above the roll transposes, nudges, resizes, deletes, undoes, and *Join*
   turns selected notes of the same pitch into one long note (for a held note the transcription split). Edits
   save automatically and can be reverted to the original transcription (track menu → *Revert note edits*).
6. **Tracks**: tap **Add track** under the last track to record another part over the sketch. After the
   count-in, the existing tracks play from the playhead (or from the first track's downbeat, if the playhead
   is before it) while you record, and the new track is lined up with them. Use headphones if you do not want
   the other tracks in the new recording (and in its transcription). Each track has a title bar: the arrow
   collapses it to a strip of its notes; the name can be edited; **M** mutes it, **S** solos it, and the
   **●** toggle arms it to *record a new take*: a record button then appears next to play, and the new take
   replaces the one the track plays (the earlier takes are kept; the track menu ⋯ switches between them,
   deletes one, deletes the track, or *Line up* moves the take earlier or later in 20 ms steps if it does not
   sit right). All tracks share one zoom and scroll.
7. **Share**: the share button (or swiping a sketch left in the list) asks which files to include: the
   **video** (original take), the **recorded audio** on its own, the **notes audio** (the transcription played by
   the built-in piano) and **MIDI**. Then it opens the iOS share sheet, or a folder picker on desktop. For a
   sketch with several tracks, the recorded audio and the notes audio are the tracks you hear mixed together
   (muted tracks left out), the MIDI file has one MIDI track per track, and the video is the take shown in the
   sketch.
8. **Organise**: in the list, swipe a sketch left for *Share* / *Delete*; press and hold to select several, then
   share or delete them together.
9. **Apple Watch**: record on the Watch and the take arrives here as a sketch tagged *Apple Watch*. Pair once
   with Settings → *Apple Watch* → *Pair Apple Watch*, which shows a code to type on the Watch; the Watch then
   shows which device it sends to. Setup and details: [watch-app/README.md](watch-app/README.md).

## Transcription settings

Basic Pitch (the model) listens for any pitched sound, so the notes it reports are cleaned up for a piano
afterwards (`src/lib/transcription/noteCleanup.ts`). Two choices in Settings → *Transcription* control that,
and apply to the next transcription. To redo a track with other settings, open the sketch and choose the
track's ⋯ → *Transcribe again*, which shows the same choices; the model's output for the last take transcribed is
kept in memory, so this is quick.

**Recorded in a room that is**

| Choice | What it does |
| --- | --- |
| *Quiet* | Keeps every note the model reports (the previous behaviour). |
| *Normal* (default) | Drops notes whose sound in the recording is more than 28 dB below the take's loud notes. |
| *Noisy* | Keeps only notes that start with a key strike (a clear onset in the model's output), are within 20 dB of the loud notes and last at least 150 ms. Can drop very soft or very fast notes. |
| *Custom* | Each of those filters with a slider. |

**Held notes**

| Choice | What it does |
| --- | --- |
| *As detected* | Notes stay the way the model cut them. |
| *Join* (default) | When a note fades below the model's threshold while other notes are played over it and comes back, the parts are joined, as long as the part that comes back has no onset of its own (up to 1.5 s apart). A key struck again is never joined. |
| *Join more* | Also joins when the part that comes back has an onset but no real attack, which is what happens when the held note's octave is struck. Joins up to 3 s apart. Can join a softly repeated note inside a chord. |

Measured on test pieces rendered from sampled piano notes (seven clean pieces, and one 20-second piece mixed
with synthetic background sounds: pink noise, voice-like babble, mains hum, thumps), counting against the notes
that were played:

- Eight notes held for 4–8.5 s under other playing split into 27 extra fragments before; 7 with *Join* and 0 with
  *Join more*. *Join* lost no played note; *Join more* merged 3 of the 57 notes in the two clean pieces into
  the note before them (chord tones struck again softly).
- With voice-like babble 20–30 dB below the piano, 50 false notes before; 36 with *Normal* and 14 with *Noisy*,
  with no played note lost.
- With the babble only 10–12 dB below the piano, 79 false notes before and 28 with *Noisy*. The rest are loud
  enough to pass the gate and look like key strikes to the model.
- Under pink noise, hum and thumps, *Noisy* dropped 3 of 198 played notes.

These are synthetic recordings, not a real room or a real piano with pedal, so the presets are a starting point.
If *Noisy* drops notes you played, use *Custom* and lower the gate or the strike threshold. The *Join* button in
the editor fixes individual splits by hand.

## Project layout

```
src/                         Svelte + TypeScript UI and engines
  lib/capture/               Capture Engine contract + native (iOS) and web backends
  lib/transcription/         TranscriptionEngine contract + Basic Pitch (worker)
  lib/music/                 Chords, MIDI, summaries, note helpers, playback synth
  lib/library/               Sketch Library client (Tauri) + in-memory dev backend
  lib/pipeline/              Background processing queue
  lib/export/                Share/export: picks and prepares files per sketch
  lib/vision/                Future visual analysis / fusion interfaces
  lib/state/                 App state and the capture flow
  lib/watch/                 Receiving recordings from the Apple Watch app
  lib/ui/                    Components (home, recorder, sketch view, piano roll…)
src-tauri/                   Rust app: Sketch Library (SQLite + files), Watch receiver, IPC commands
plugins/tauri-plugin-capture Native capture plugin (Swift/AVFoundation on iOS)
plugins/tauri-plugin-watch-link  Apple Watch receivers on iOS (Bluetooth LE, WatchConnectivity)
watch-app/                   Apple Watch app (SwiftUI) and the EarbudLink protocol package
docs/                        Architecture and iOS guides
scripts/                     Model copy, test-audio generator, end-to-end smoke tests
```

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for module boundaries, data flow and extension points.

## Testing

```bash
npm test                             # Vitest: WAV/resampling, chords, MIDI, capture flow, real Basic Pitch inference
npm run check                        # svelte-check / TypeScript
(cd src-tauri && cargo test)         # Sketch Library and Watch receiver (pairing, transfers over TCP, import)
```

End-to-end smoke tests (optional, need Playwright's Chromium or `tauri-driver`):

```bash
node scripts/make-test-audio.mjs /tmp/chords.wav
```

```bash
SMOKE_WAV=/tmp/chords.wav npm run smoke:browser   # with `npm run dev` running
```

```bash
npm run smoke:playback   # scrub, play, crop and loop on the ?demo sketch, with `npm run dev` running
```

```bash
npm run smoke:edit       # drag-select, move, transpose, delete, join and undo notes on the ?demo sketch
```

http://localhost:1420/?demo=tracks opens the demo with a second track, for working on the multi-track view.

`npm run smoke:tauri` drives the real desktop app (Rust, SQLite, IPC, asset protocol) through WebDriver on
Linux; the header of `scripts/tauri-webdriver-smoke.mjs` explains the setup.

## Known limitations

- **iOS has been run on one device so far.** Recording start-up was unreliable in early builds (the camera
  preview was attached to the session while recording was starting). The fix has not been confirmed on hardware yet. If recording misbehaves, Settings → Diagnostics shows a recording
  log; see [docs/IOS.md](docs/IOS.md#troubleshooting-recording).
- **Transcription accuracy** is that of Basic Pitch: expect occasional ghost notes from strong harmonics,
  octave confusions, and approximate note ends with the sustain pedal down. Velocities are estimated from
  model activations, not measured. Low-confidence notes are drawn fainter. The environment settings remove
  background sounds that are quieter than the piano or have no attack; a loud voice or a second instrument
  still produces notes, and ghost notes from the piano's own harmonics are as loud as the piano and stay.
  Basic Pitch is a general model (not trained on piano only) and offers no way to adapt it to a room; a
  piano-specific model could replace it behind the same engine interface (see the architecture doc).
- **Transcription speed**: in this repository's tests (software rendering, no GPU) a 6–7 second take took
  13–16 s to transcribe. GPU (WebGL) inference should be faster but has not been measured on an iPhone.
  Inference runs in a worker, with a main-thread WebGL fallback on iOS versions without WebGL in workers.
  If it is too slow on device, the engine interface allows a native Core ML backend (see the architecture doc).
- **Android** has no native capture backend yet. The web backend may work but has not been tested.
- **Linux desktop**: WebKitGTK cannot stream media from custom URL schemes, so playback falls back to loading
  the file into memory (fine for typical sketches). Camera and microphone access depend on the distribution's
  WebKitGTK build.
- **Tracks on iOS** have not been tried on a device. The other tracks play through the web view while the
  native recorder runs; the recording audio session is mixable (`.mixWithOthers`), so this should work, but it
  is unconfirmed, as is playing several media elements at once in the iOS web view. How well a new track lines
  up depends on how precisely the app knows when the recorder started; if one sits early or late, use the
  track menu's *Line up*. Without headphones the other tracks are recorded into the new one.
- **Background recording** is not supported: iOS stops the camera when the app leaves the foreground. The take
  up to that point is saved automatically.
- **Apple Watch**: Wi-Fi and Bluetooth delivery need Earbud open on the receiving device. watchOS may block the
  Watch's direct Wi-Fi connections (Apple TN3135); the Watch then falls back to Bluetooth or its paired iPhone.
  See [watch-app/README.md](watch-app/README.md).
- No notation, quantization or tempo detection yet. MIDI is exported in real time (120 BPM header).

## License

MIT for Earbud's own code. Basic Pitch (model and library) is Apache-2.0, © Spotify AB.
