# Running Earbud on iPhone and iPad

Earbud's iOS build uses Tauri 2's iOS support. Recording is done natively by
`plugins/tauri-plugin-capture` (Swift + AVFoundation). Everything else
(storage, transcription, UI) is shared with desktop.

> **Status:** the app builds and runs on iPhone. The first device build had unreliable recording start-up
> (a take ending as soon as it started, or hanging on "Starting…"). The current version changes the audio
> session and start-up handling to address that (see [How capture works](#how-capture-works-on-ios)), but the fix
> has not been confirmed on a device yet. Use the [device checklist](#first-run-checklist-on-a-device) and the
> [recording log](#troubleshooting-recording).

## One-time setup (macOS)

1. Install **Xcode** from the App Store and open it once to install the iOS platform and accept the license.
2. Install Rust and the iOS targets:

   ```bash
   rustup target add aarch64-apple-ios aarch64-apple-ios-sim
   ```

   On an Intel Mac, also add `x86_64-apple-ios` for the simulator.
3. Install JavaScript dependencies (this also copies the Basic Pitch model into `public/models/`):

   ```bash
   npm install
   ```
4. Generate the Xcode project (creates `src-tauri/gen/apple`):

   ```bash
   npm run tauri ios init
   ```

   If it reports missing tools, run `npm run tauri info` and follow its advice.

### Code signing

You need an Apple ID signed into Xcode (Settings → Accounts). A free Personal Team works for installing on
your own device; provisioning profiles from a free team expire after 7 days.

Find your Team ID (Xcode → Settings → Accounts → your team, or `npm run tauri info`) and either export it:

```bash
export APPLE_DEVELOPMENT_TEAM=ABCDE12345
```

or set `bundle > iOS > developmentTeam` in `src-tauri/tauri.conf.json`.

The bundle identifier is `com.earbud.sketchbook` (`identifier` in `src-tauri/tauri.conf.json`). If signing
complains that it is taken, change it to something unique to you (e.g. `com.yourname.earbud`) and re-run
`npm run tauri ios init`.

## Running on a physical iPhone (e.g. iPhone 13 Pro)

1. Connect the phone by cable (or pair it over Wi-Fi in Xcode → Window → Devices and Simulators).
2. On the phone, enable **Developer Mode** (Settings → Privacy & Security → Developer Mode) and restart when asked.
3. Optional, for debugging: Settings → Safari → Advanced → **Web Inspector** on. You can then inspect the
   webview from Safari on the Mac (Develop menu → your iPhone).
4. Run in development mode. The phone loads the UI from the Vite dev server on your Mac, so both must be on the
   same network:

   ```bash
   npm run tauri ios dev -- --host
   ```

   To pick the device by name instead of being prompted, put the device name after `dev`:

   ```bash
   npm run tauri ios dev "Your iPhone" -- --host
   ```

   `vite.config.ts` already reads `TAURI_DEV_HOST`, which the Tauri CLI sets, so the dev server listens on the
   Mac's network address.
5. If the app fails to install with "untrusted developer", trust your certificate on the phone: Settings →
   General → VPN & Device Management.

Alternatively, `npm run tauri ios dev -- --open` opens the project in Xcode, where you choose the device and press Run.

### A build that works without the Mac

The development build needs the Mac's dev server. To install a self-contained build (UI bundled into the
app, fully offline):

```bash
npm run tauri ios build -- --debug
```

Install the resulting `.ipa` (under `src-tauri/gen/apple/build/`) with Xcode → Devices and Simulators, or open
the project with `--open` and run a **Release** scheme. For TestFlight/App Store distribution use
`npm run tauri ios build -- --export-method app-store-connect`. That requires a paid developer account.

### Simulator

`npm run tauri ios dev` with no device runs in the iOS Simulator. The Simulator has **no camera**, so recording
fails there with a "camera is not available" message. Choose **Audio only** in Settings to record from the
Mac's microphone, or use the browser preview (`npm run dev`).

## Permissions

The app asks for **Microphone** and **Camera** the first time you tap Record. The prompt text comes from
`src-tauri/Info.ios.plist`, which the Tauri CLI merges into the generated app `Info.plist` on every build:

| Key | Purpose |
| --- | --- |
| `NSMicrophoneUsageDescription` | Recording the piano |
| `NSCameraUsageDescription` | Recording your hands at the keys |
| `UISupportedInterfaceOrientations` | Portrait and both landscape orientations, so the phone can be propped up either way |

If access was denied, Earbud shows an **Open Settings** button that takes you to the app's page in Settings.
If only the camera is denied, you can record audio-only sketches.

No other permissions are used. There is no network access, photo-library access or background mode.

## How capture works on iOS

- `AVCaptureSession` with the back (or front) camera at 1280×720 and the built-in microphone.
- `AVCaptureMovieFileOutput` writes a QuickTime `.mov` (H.264 + AAC) **directly into the sketch's folder**.
  Audio and video share the capture clock, so they stay in sync. It writes movie fragments as it goes, so if the
  app is killed mid-take the recording up to the last fragment usually survives. Earbud recovers such takes on
  the next launch.
- The live preview is an `AVCaptureVideoPreviewLayer` inserted **behind** the WKWebView, with the webview made
  transparent while recording. No frames cross the JavaScript bridge; JS receives only small events (input level
  10×/s, interruptions, completion) over a Tauri `Channel`.
- Auto-lock is disabled while recording.
- The audio session uses `.playAndRecord` with `.videoRecording` mode by default. Settings → *Unprocessed
  microphone* switches to `.measurement` mode (no system AGC/EQ; more faithful but quieter). After recording the
  session returns to `.playback`, so review playback ignores the silent switch.
- The recording session is **mixable** (`.mixWithOthers`). WKWebView plays audio from a separate process with its
  own audio session; a non-mixable recording session and the web view's session can interrupt each other, which
  ends the recording the moment it starts. A side effect: music already playing in another app keeps playing
  (and is picked up by the microphone). Pause it before recording.
- Start-up is defensive: the recorder waits for the app to be active after the permission alerts, waits for the
  capture connections to come up before writing, and gives up after 6 s without data instead of hanging. The app
  retries a failed start once automatically. A take that ends by itself within 1.5 s is not saved and is retried
  once. Stop taps in the first 0.6 s are ignored, so a double tap on Record does not stop the new take.
- **Interruptions** (phone call, Control Center camera use, app sent to the background) end the recording.
  AVFoundation still finalizes the file, and Earbud saves it as a sketch.
- After saving, `extractAnalysisAudio` decodes the movie's audio track with `AVAssetReader` to a 22.05 kHz mono
  16-bit WAV (`analysis.wav`) for transcription. The `.mov` is only read.
- Export uses the native share sheet (`UIActivityViewController`): AirDrop, Files, Mail, etc.

Lens choice: Settings → Camera → *Ultra wide* uses the 0.5× camera on devices that have one (iPhone 13 Pro
does), which fits a full keyboard from closer up.

## First-run checklist on a device

These behaviours could not be verified without hardware. Please check them on the first device build:

1. **Build**: the `tauri-plugin-capture` Swift package compiles. Likely trouble spots, if any: AVFoundation
   API deprecations treated as errors in newer Xcode versions (`videoOrientation`, `tracks(withMediaType:)`), or
   Swift 6 strict-concurrency warnings promoted to errors. The package declares Swift tools 5.5, so it builds in
   Swift 5 mode.
2. **Permissions**: the first Record tap shows the microphone and camera prompts with Earbud's text.
3. **Preview**: while recording, the camera image fills the screen behind the timer, level meter and stop button.
   If the screen is black, the webview may not be transparent (see `showPreview` in `CapturePlugin.swift`).
4. **Saving**: stopping returns to the list with a new card; the duration is right. Try ten takes in a row,
   including one right after reviewing a sketch with sound. Each should start on the first tap. If one does not,
   copy the recording log (see [Troubleshooting](#troubleshooting-recording)).
5. **Transcription** completes. The progress percentage moves; a chord progression appears on the card.
6. **Playback**: opening a sketch plays video *with sound* in the page (not full screen), and the piano roll
   follows. If the video does not load, the app retries from memory and then falls back to the extracted audio.
   A notice says so. Please report which case you hit.
7. **Silent switch**: playback is audible with the ring/silent switch on silent.
8. **Rotation**: recording in landscape produces a correctly oriented video.
9. **Interruption**: start recording and press the Home/lock button. On return, the take should be in the list.
10. **Export**: the share button offers the `.mov` and `.mid` files.

To look at what is stored, Safari's Web Inspector console can run:

```js
await window.__TAURI_INTERNALS__.invoke('library_info')
```

## Troubleshooting recording

Settings → **Diagnostics** → *Show recording log* shows a timestamped log of recent recording attempts from both
the app and the native recorder: audio-session category and route, how long the camera took to start,
interruptions (with the reason iOS gave, e.g. "the microphone was taken by another audio session"), and error codes.
*Copy* puts it on the clipboard. Please include it when reporting a recording problem. The same lines also go to the
device console with the prefix `[earbud-capture]` (Xcode console, or Console.app with the phone connected).

## Storage location

`Library/Application Support/com.earbud.sketchbook/library/` inside the app container:

```
earbud.sqlite3
sketches/<id>/recording.mov      original (immutable)
sketches/<id>/analysis.wav       derived audio for transcription
sketches/<id>/transcription.mid  current notes as MIDI
sketches/<id>/exports/           friendly-named hard links used for sharing
```

The folder is included in device backups. Deleting a sketch in the app removes its folder.

## Unsupported or deferred on iOS

- Recording in the background, or with the screen locked.
- External audio interfaces have not been tested. AVFoundation will use whatever input the system routes; USB
  interfaces should work, Bluetooth microphones are deliberately not selected.
- Native Core ML transcription: the engine interface supports it (see `docs/ARCHITECTURE.md`), but Basic Pitch
  runs in the webview in this version.
- Apple Vision hand/key tracking: interfaces only (`src/lib/vision/types.ts`).
