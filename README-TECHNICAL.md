# Earbud — technical notes

The short introduction and download links are in [README.md](README.md).

## Overview

Earbud is a small, offline-first app for capturing piano ideas. Earbud keeps the original audio and video,
transcribes the notes and chords in the background, and lets you replay a take, see its key and chords and how
to play them on piano or guitar, correct the notes on a piano roll, add text notes, and export the recording
and a MIDI file.

It is meant to feel like a notebook, not a digital audio workstation.

> **This branch (`claude/funny-hawking-vvop92`) is an experimental interface.** The list of sketches, the main
> record button and tracks are gone. A **notebook** is an endless canvas whose horizontal axis is one timeline:
> press and hold anywhere to record audio, import audio or tap out a rhythm at that point; the playhead plays
> every sketch it crosses, together. See [The notebook canvas](#the-notebook-canvas-this-branch). Libraries from
> `main` are not carried over: sketches made before this branch are kept in the database but are on no canvas.

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
| Notebook canvas (this branch): notebooks, free placement on a timeline, long-press to create, playhead plays what it crosses, minimap, repeat range | Done, checked in Chromium (`npm run smoke:notebook`); not yet run on an iPhone |
| Rhythm sketches (this branch): four pads, tempo detected from the taps, 16th-note step sequencer, repeat by dragging, export as audio and MIDI drums | Done, unit tested; checked in Chromium |
| Sketch menu on the canvas (this branch): copy and paste (also into another notebook), duplicate, export, delete; recordings repeat by dragging their right edge | Done, unit tested (Rust and TS); checked in Chromium |
| Rhythm view (this branch): full-size step sequencer, bars side by side to swipe between, velocity by dragging, record pads into the loop, a sound per pad (built in or a library sample), swing, tap tempo, undo | Done, unit tested (player, swing, bars, pad samples); checked in Chromium at phone and iPad sizes (`npm run smoke:samples`) |
| Sample library (this branch): cut a passage from a sketch's waveform (Ctrl + drag, or a 2 s hold), a grid of samples that play on tap, an editor (trim, envelope, level, tone, reverb, transpose, reverse, root note); rhythm pads and a sketch's notes can play samples | Done, unit tested (TS: pitch detection, settings, cutting, the sampler; Rust: storage); checked in Chromium (`npm run smoke:samples`); not yet on a device |
| Space bar, play after returning to the app, page zoom (this branch): space plays and pauses whatever is in front; every view starts a fresh audio context in the tap after the app was in the background; only the canvas and piano rolls zoom | Done, unit tested (space bar, context renewal); checked in Chromium; the background case is simulated there, not yet confirmed on an iPhone |
| Guitar chord previews (this branch): recorded steel-string guitar notes, strummed | Done, unit tested (zones, strum); checked in Chromium |
| Text notes on the canvas (this branch): double-tap to write, markdown, move and resize, emoji-only notes large and on the minimap | Done, unit tested (markdown, storage); checked in Chromium |
| Sketch volume and Slice (this branch): a volume slider in the sketch menu, shown as a bar on the sketch's left; Slice cuts a recording or a rhythm into two sketches | Done, unit tested (Rust storage, slice geometry); checked in Chromium |
| Reference section (this branch): every chord of a root on one page with piano and guitar diagrams (all shapes); circle of fifths that records tapped chords as a sketch | Done, unit tested (chord taps); checked in Chromium at phone and iPad sizes |
| Recording in place on the canvas (this branch): count-in, beat and level in a strip where the sketch goes | Done, checked in Chromium with a fake microphone (`smoke:browser`); not yet on a device |
| Separate microphone and output (Settings → Audio) | Browser/desktop: done, unit tested (output routing), checked in Chromium with fake devices. iOS: written, not compiled or tried on a device |
| iPad trackpad scrolling on the canvas | Info.plist fix from Snorkle applied (native indirect input, single-window scene); not yet confirmed on an iPad |
| Home screen, one-tap record, chronological library | Replaced on this branch by the notebook canvas |
| iOS synchronized audio/video capture (AVFoundation) | Builds and runs on iPhone; start-up reliability fix pending confirmation on a device (see [docs/IOS.md](docs/IOS.md)) |
| Desktop / browser capture (MediaRecorder) | Done, tested in Chromium |
| Local storage (SQLite + files), crash recovery | Done, unit tested |
| Offline Basic Pitch transcription | Done, tested on synthesized two-handed chords |
| Chord names, MIDI export | Done, unit tested |
| Chords section: key, chords used with piano and guitar diagrams, circle of fifths | Done (experimental), unit tested; checked in Chromium |
| Playback through one Web Audio graph (all tracks sample-locked, limiter, gapless loop, slowed playback by WSOLA) | Done, unit tested and checked in Chromium; not yet run on an iPhone or Mac |
| Piano roll, synchronized playback, note editing (on this branch always editing; moved notes are heard) | Done, tested end to end in Chromium and in the Linux desktop app (earlier versions); `npm run smoke:edit` on this branch |
| Tracks (layered recordings in one sketch), takes, mute/solo, count-in | On this branch: kept in storage and in the capture flow, not shown (layering happens on the canvas); count-in kept |
| Tempo: detection from the first recording, editor with a click, beat-aligned takes | Done, detection unit tested on synthesized playing (not on real recordings yet) |
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
demo notebook (three piano sketches rendered with the built-in synth, and a rhythm under them) for working on the
UI without recording.

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

## The notebook canvas (this branch)

A notebook is a canvas: left to right is time (the ruler along the top shows it), and sketches sit anywhere
vertically. Everything below works with a finger, a mouse or a trackpad.

| Gesture | What it does |
| --- | --- |
| Press and hold empty canvas (right-click with a mouse) | A menu at that point: **Record audio**, **Import audio**, **Record rhythm**. The new sketch starts there. |
| Tap empty canvas | Moves the playhead there. |
| Tap a sketch | Plays it on its own (the canvas playhead waits, dimmed). Tap again to stop. |
| Double-tap a sketch | Opens it: a recording in the sketch view, a rhythm in the rhythm view, a text note to edit. |
| Double-tap empty canvas | Writes a text note there (markdown). Tap elsewhere, Esc or ⌘/Ctrl+Enter to finish; a note left empty goes. |
| Hold a sketch | Its menu: a **volume** slider, **Copy**, **Duplicate**, **Slice**, **Export**, **Delete**. Keep holding and drag instead to move the sketch (time and height); the menu closes. |
| Drag a sketch's right edge | Repeats it: a recording plays its playing part again, whole times in a row (×2, ×3…); a rhythm repeats its pattern over more (or fewer) bars. |
| Drag; pinch, or ctrl/⌘ + scroll | Scrolls the canvas; zooms the timeline. |

- **Reference.** The book button opens the Reference section: see [Reference](#reference).
- **Samples.** The button between Reference and Settings opens the sample library: see [Sample library](#sample-library).
- **The space bar** plays and pauses whatever is in front: the canvas (or stops a recording onto it), an open sketch
  (with the click when the tempo sheet is open), a rhythm, the rhythm panel's pattern, the sample last played in the
  library, or the sample being edited. Not while typing in a text field (sliders, checkboxes and buttons do not count).
  A focused play button is not also pressed by the space bar (that toggled twice, so play seemed to do nothing).
- **Notebooks.** The title at the top opens the list of notebooks, with *New notebook*, *Rename* and *Delete*
  (which deletes its sketches). The first launch creates *Notebook 1*. Each notebook remembers its scroll, zoom and
  repeat setting.
- **Record audio** records in place, in a red strip where the sketch will be, so the rest of the notebook stays in
  view. The strip shows *Starting…*, then the count-in (the beat number and a pip per beat, with the ticks), then
  the time, the input level as a waveform as it comes in and, over a rhythm, a dot that flashes on its beats. It
  grows with the playhead (it starts about 170 px wide). Its stop button (or the dock's play button, which is a stop
  button while recording, or the space bar) stops and saves; during the count-in it cancels. While recording, the
  canvas can be scrolled and zoomed; taps and holds do nothing else. After the count-in the canvas plays from the
  point you held, so you can play over what is already there; the new sketch is placed so its downbeat lands where
  you heard the canvas at that moment (playback latency is taken off, as for tracks before). Held over a rhythm, the
  count-in runs at the rhythm's tempo and the start moves to its nearest beat. The sketch appears where you held:
  its title over its waveform. Its count-in is not shown or played. The camera (Settings) still records video, but
  its image is not shown while recording onto the canvas.
- **Import audio** opens the import sheet used before: an audio file (transcribed like a recording) or a MIDI file
  (its notes, played by the built-in piano). It is placed where you held.
- **Record rhythm** opens a panel you can drag by its top. Tap the four pads (*Beat 1* to *Beat 4*, which sound as a
  kick, a snare, a hat and a clap; keys 1 2 3 4 or J K L ;); recording starts with the first tap. *Done* turns the taps into a pattern: the tempo is detected,
  the beat nearest the first tap becomes bar 1, every tap moves to the nearest 16th note, and the pattern is as many
  whole 4/4 bars as you played (a lone downbeat at the end is taken as the loop coming round and dropped). The step
  sequencer then shows it: tap steps on or off, change the tempo or the number of bars, play it in a loop, or
  record again. *Save* puts it on the canvas.
- **The rhythm view** (double-tap a rhythm) is its full-size editor. At the top, every bar with all four pads (tap a
  bar to go to it; *+ Bar* adds a copy of the last bar, *×2* doubles the pattern, *− Bar* removes the last). Below,
  the bars **side by side**, the one being edited in the middle: swipe sideways between them (on an iPad the bars
  either side show, dimmed; on an iPhone only the edges). Each shows one pad's bar as 16 large steps, a row per
  beat: tap a step to switch it on (at 80 %) or off (a step of a bar at the side also brings that bar to the
  middle); drag up or down on a step to set its velocity, shown as how full it is and as a number. While the loop
  plays, the bars follow it until you swipe. The four pads under the bars sound, choose the pad the bars show, and
  with **record** (the red button next to play) on while the loop plays, write each hit on the step it was meant
  for. **Sound** (next to the pad's name above the bars) chooses what the pad plays: its own sound (kick, snare,
  hi-hat, clap) or a sample from the library, heard in the view, on the canvas and in the exported audio (the MIDI
  export keeps the pad's drum note). Also: tempo (− / + and *Tap*), **swing** (every second 16th later, up to half a
  step), how many bars it plays on the canvas, undo / redo (⌘/Ctrl+Z), and *Clear* for a pad. Edits save
  themselves. Keys: 1 2 3 4 or J K L ; for the pads, ← → between bars, space to play.
- **Text notes.** Double-tap empty canvas to write one where you tapped. Markdown: `#` headings, `**bold**`,
  `*italic*`, `~~strike~~`, `` `code` ``, lists and task lists (`- [ ]`, `- [x]`), `>` quotes, fenced code, `---`
  rules, and `[links](https://…)`; a single line break stays a line break. A note sits at a point of the timeline
  (zooming moves it, it does not stretch). Hold it to move it or for its menu (*Edit*, *Copy*, *Duplicate*,
  *Delete*), drag its corner to resize it, double-tap to edit. A note that is only emoji is shown at 50 px without a
  box or a resize corner, and its emoji appears, small, on the minimap. Notes do not play.
- **Volume.** The slider at the top of a sketch's menu sets how loud it plays on the canvas (0–100 %, saved with the
  sketch and kept by copies). Below 100 % a short vertical bar on the sketch's left shows how much. The recording is
  not changed, and the sketch view plays it as recorded.
- **Slice.** *Slice* in a sketch's menu puts a red cut line on the sketch where you held it: tap or drag along the
  sketch to move it, then *Slice* (or *Cancel*, or Esc). The sketch becomes two sketches that stand on their own, side
  by side, the second titled "… (2)". A recording is not cut: both halves keep the whole recording and play the parts
  before and after the cut (as crops, which the sketch view can widen again). A recording that repeats is cut in its
  first pass, and both halves then play once. A rhythm is cut on a bar line (at least one bar each side); the second
  half carries on from where the first stops in its pattern.
- **The sketch menu.** *Copy* keeps the sketch for pasting: press and hold the canvas, in this notebook or another,
  and the menu there has *Paste*, which puts a copy where you held. *Duplicate* puts a copy right after the sketch
  (after its repeats), at the same height. A copy has the recording, the notes with your edits, the crop, tempo,
  text notes and repeats (or the rhythm), and stands on its own: deleting either leaves the other (the recording is
  hard-linked on disk, not stored twice). *Export* opens the export sheet: for a recording as before (video,
  recorded audio, notes audio, MIDI), for a rhythm its **audio** as it plays on the canvas (repeats included) and
  **MIDI** (General MIDI drums on channel 10: kick 36, snare 38, closed hi-hat 42, at the rhythm's tempo).
- **Repeats.** A recording's repeats play back to back on the same audio clock, each one more track in the playback
  engine; on the tile, the repeats after the first are drawn lighter, with a dashed line where each starts (a rhythm
  that is longer than its pattern has one where the pattern comes round). To loop a
  phrase, crop it in the sketch view, then drag its right edge on the canvas.
- **Playing.** The control bar at the bottom has play, the playhead's time, **repeat** and *show the whole
  notebook*. The playhead plays every sketch it crosses, together, on one audio clock; the view follows it.
  A recording plays from its downbeat to its end, or only its crop if one is set in the sketch view. After a
  recording, after the app was in the background, and after a play that got no sound within 2 s, the next tap
  starts the canvas's sound with a fresh audio context (see Known limitations). The sketch view, the rhythm view,
  the rhythm panel and the sample library do the same (they each have their own sound): play used to stop working
  in them after leaving the app and coming back. Each play writes the audio state to Settings → Diagnostics.
- **Repeat** plays only the loop range, over and over: turning it on (or play) puts the playhead at the range's
  start when it is outside it, and a tap on the canvas outside the range leaves the playhead at the range's edge.
  The range is from the first sketch to the end of the last unless set: drag its red handles on the ruler along the
  top of the canvas or on the minimap; it is saved with the notebook, and *Loop everything* clears it. On the
  canvas, the range's two edges are dashed red lines down its whole height.
- **Minimap.** Above the control bar: the whole notebook, the part in view (everything outside it is faded), the
  playhead and, with repeat on, the loop's handles. Drag on it to move the view.
- **A sketch** (double-tap) is the sketch view from before without tracks: piano roll, chord strip and waveform,
  the Chords section, the video, notes, tempo, crop, loop, *Take / Notes / Both*, note editing, transcribing again
  and sharing. The piano roll is **always editing** (no pencil): tap a note to select it, tap empty space to
  deselect and move the playhead there, hold and drag to select several, drag a selection to move it, drag an end
  to resize, double-tap to add; the editing toolbar is always above the roll. **Every move is heard**: the selected
  notes sounding at the playhead play, or, when none of them crosses the playhead, the ones struck at the start of
  the selection (on each new pitch or each change of what is under the playhead while dragging, on each arrow key or
  toolbar step, and once where a sideways drag lands). The ⋯ menu above the roll has *Use sample…* (see
  [Sample library](#sample-library)). The *Take / Notes / Both* choice is saved per sketch across app launches and also controls its
  canvas playback. *Notes* plays the current edited transcription and shows a miniature piano roll on the canvas;
  *Take* and *Both* show the waveform. Crops and repeats apply to the selected sound. *Back* returns to the canvas.
- **Apple Watch** recordings are placed at the end of the open notebook.
- **Audio input and output** (Settings → Audio) are chosen separately; see [Audio devices](#audio-devices).

### Sample library

The button between Reference and Settings opens it: every sample as a button with its waveform and name.

- **Making a sample.** In a sketch, on the waveform under the piano roll: hold **Ctrl** and drag across a passage, or
  **press and hold** the waveform for **two seconds** without moving (the magnifier opens first; keep still), then
  drag to set the other end, or let go for a passage of a second. The passage is shaded with handles at its ends, and
  a tooltip over it has a play button, **Add to library**, its length and ×. *Add to library* cuts the passage out of
  the take's decoded sound (mono, as a WAV of its own, at most 60 s) and finds its pitch; the toast has *Open*. A tap
  elsewhere on the waveform, × or Esc lets the selection go.
- **The library.** Tap a sample to hear it (tap again to stop; the space bar plays the last one again). **Press and
  hold** (or right-click) for its menu: *Edit sample…* and *Delete*.
- **The editor** (settings saved as you go; the stored audio is never changed): the name; the waveform with
  **trim** handles (or ← → on a focused handle); **Level** (−24 to +12 dB), **Attack** (fade in), **Decay** (how long
  the sound takes to die away, or off), **Release** (fade out at the end), **Normalize**, **Reverse**; **Reverb** (how
  much) and **Room** (how long it rings), **Tone** (a high cut), **Low cut**, **Transpose** (semitones, faster or
  slower); and **Sounds at**, the note it plays notes from (found in the sound when it has a steady pitch, with how
  many cents off it is; − / + to set it by hand, *Detect* to look again). The play button (or space) plays it as set.
- **Rhythm pads** can play a sample instead of their own sound (the rhythm view's *Sound*).
- **A sketch's notes** can play with a sample: the ⋯ menu above the piano roll → *Use sample…* → a sample (each
  with a play button that plays a chord with it) or *Piano*. Each note plays the sample resampled from its root to
  the note (2^(semitones/12) times as fast, with the cents found in it taken off so it is in tune), held for the
  note's length and released, or until the sample ends. Choosing a sample while *Take* is selected switches to
  *Notes*. The canvas (in *Notes* and *Both*), note previews, moved-note auditions and the *Notes audio* export use
  it too. The ⋯ menu shows which sample is in use.
- Deleting a sample sends pads that played it back to their own sounds and sketches whose notes played with it back
  to the piano.

### Audio devices

Settings → *Audio*:

- **In a browser or the desktop app**: *Microphone* lists the system's microphones (with *System default*), used
  for every recording. *Output* lists its outputs where the web view can send Web Audio to one (Chromium: Chrome,
  Edge and the Windows app; `AudioContext.setSinkId`). Playback, the canvas, the count-in, the pads and the
  Reference section all play there. Safari and the macOS and Linux web views cannot, and play through the system's
  output (set in the system's sound settings). *Play a test sound* checks the output; *Show device names* appears
  when the browser hides names until the microphone has been allowed. A chosen microphone that is not connected
  falls back to the default, with a warning in the recording strip.
- **On iPhone and iPad**: *Microphone* is *Automatic*, *Built-in*, *Bluetooth* or *Headset or USB*, and *Sound while
  recording* is *Automatic* (headphones when connected, otherwise the speaker) or *Speaker*. iOS ties some of these
  together: a Bluetooth microphone uses the headset's hands-free profile, and iOS then plays through that headset,
  so *Bluetooth* microphone with *Speaker* output is not possible (forcing the speaker also moves the input back to
  the built-in microphone). The other way round works: the built-in (or a wired or USB) microphone records while
  Bluetooth headphones play. Outside recording iOS chooses the output (Control Center). Not yet tried on a device;
  the recording log in Settings → Diagnostics names the input and output used.

### Reference

The book button next to Settings. Two tabs (the one last used opens):

- **Chords.** The roots down the side (A, A♭, B, B♭, C, D, D♭, E, E♭, F, G, G♭, with the sharp each flat also is).
  Choosing one shows all of its chords on one page: major, minor, 7, maj7, m7, dim, aug, sus2, sus4, 6, m6, add9, 9,
  maj9, m9, m7♭5, dim7, m(maj7), 7sus4 (the chords the transcription recognises). Each has its name in words, its
  notes and how to play it with the *Piano | Guitar* choice (the same choice as the sketch view's Chords section):
  a keyboard, or every guitar shape found for it side by side, easiest first, each labelled with where it sits on
  the neck. The play button plays the chord; tapping a guitar shape plays that shape. Guitar shapes sound like a
  **guitar**: recorded steel-string notes (one every major third, each chord note resampled from the nearest by at most
  two semitones), strummed from the lowest string up; piano voicings play the piano. The sketch view's Chords
  section plays guitar shapes the same way.
- **Circle of fifths.** The same circle as in a sketch's Chords section. Tap a chord to hear it; its key's wedge is
  shaded and how to play it appears below the circle: a keyboard, or all its guitar shapes stacked (tap one to hear
  it; the one last heard is what a recording plays). The small record button under the circle,
  on the right, records chords: tap it, then tap chords on the circle (recording starts with the first one), then
  tap it again. The chords become a new sketch at the end of the open notebook, titled after them (e.g.
  *C – Am – F – G*): each chord's notes as you heard them (piano voicing or guitar shape) from its tap until the
  next, the last until you stopped (at most 8 s). Like an imported MIDI file, it is played by the built-in piano and
  its notes are the transcription (nothing to transcribe). *Discard* drops a recording.

On this branch Settings, transcription, chords, editing, tempo, export and the Watch link work as described
below; where the steps below mention the list of sketches, tracks or *Record track*, the canvas replaces them.

## Using Earbud

The steps below describe `main`. On this branch, see [The notebook canvas](#the-notebook-canvas-this-branch)
for how sketches are made, placed and played; reviewing one (steps 3–6, 8, 9) is the same.

1. **Record**: prop the phone above the keys (back camera, or *Ultra wide* in Settings to fit the whole
   keyboard) and tap the red button. After a count-in of three ticks (with 3-2-1 on screen) the take begins.
   The screen stays awake while recording. Stopping during the count-in cancels the take. Settings →
   *Count-in* sets the tempo or turns it off.
2. **Stop**: the take is saved immediately with a timestamp. Name it later if you like.
3. **Transcribe**: happens automatically. The card shows progress, then the chord progression. Settings →
   *Transcription* says what kind of room you record in (*Quiet*, *Normal*, *Noisy* or *Custom*) and whether
   held notes are joined; see [Transcription settings](#transcription-settings).
4. **Review**: open a sketch. Each track is a piano roll (scroll it sideways, pinch to zoom; it follows the
   playhead and lights the sounding keys), then a strip with its **chords** (lined up with the roll and scrolled
   with it; tap one to hear it), then the waveform of its take (tap or drag to scrub; **press and hold** to open
   a magnifier that shows the waveform close up and follows your finger). A collapsed track shows just its
   waveform. Under the tracks, the **Chords** section (see step 5), then the video and your notes.
   The top bar stays on screen with the title, the time and the sketch's tempo; the bottom bar has play, what
   plays (*Take*, *Notes*, where a synth plays the transcription, or *Both*) and loop.
   Drag the bracket handles at either end of a waveform to **crop playback** to a passage (saved with the
   sketch; the recording itself is not trimmed), and turn on **loop** to repeat it.
5. **Chords**: the section under the tracks shows the sketch's key (detected from the notes; when two keys fit
   almost equally, both are named) and has two tabs. *Chords* lists the progression with roman numerals (tap a
   chord to go there and hear it), then a card for each chord used: its name, its numeral in the key, how often
   and how long it is played, and how to play it, as a keyboard (left-hand bass, right-hand chord) or a guitar
   chord box (with alternative shapes further up the neck); the play button plays that voicing. *Circle of
   fifths* shows which areas of the circle a recording covers: the chords played are filled (darker for more
   time) on three rings (major outside, minor in the middle, diminished inside), with the key's chords as a shaded
   wedge; tap any chord on it to hear it, including ones not played yet. With several tracks the section analyses the tracks you hear, together: mute or solo tracks to
   change what it reads.
6. **Edit** (on this branch the roll is always editing, without the pencil; see
   [The notebook canvas](#the-notebook-canvas-this-branch)): tap the pencil in the top-left corner of a piano roll. Tap a note to select it. A one-finger drag
   still scrolls; **press and hold, then drag** to draw a rectangle that selects every note it touches (on a
   note, press and hold picks the note up). With a mouse, drag across the roll to select (Shift adds,
   Cmd/Ctrl+A selects all). Drag a selected note to move the whole selection, drag its end to resize, and
   double-tap to add a note. The toolbar above the roll transposes, nudges, resizes, deletes, undoes, and *Join*
   turns selected notes of the same pitch into one long note (for a held note the transcription split). Edits
   save automatically and can be reverted to the original transcription (track menu → *Revert note edits*).
7. **Tracks**: tap **Record track** under the last track to record another part over the sketch. After the
   count-in, the existing tracks play from the playhead (or from the first track's downbeat, if the playhead
   is before it) while you record, and the new track is lined up with them. Use headphones if you do not want
   the other tracks in the new recording (and in its transcription). Each track has a title bar: the arrow
   collapses it to its waveform; the name can be edited; **M** mutes it, **S** solos it, and the
   **●** toggle arms it to *record a new take*: a record button then appears next to play, and the new take
   replaces the one the track plays (the earlier takes are kept; the track menu ⋯ switches between them,
   deletes one, deletes the track, or *Line up* moves the take earlier or later in 20 ms steps if it does not
   sit right). All tracks share one zoom and scroll. With several tracks, *Separate* in the bottom bar gives
   each track its own *Take / Notes / Both* choice, attached under it.
   **Import track**, next to it, adds a track from a file, starting at the start of the sketch (where the first
   track's playing begins) or at the playhead. A **MIDI file** brings its notes as they are (no transcription;
   the drum channel is left out), played by the built-in piano, which also draws its waveform. An **audio
   file** (WAV, MP3, M4A, AIFF, FLAC and the like, or a video's sound) is copied in untouched and transcribed
   like a recording. Imported tracks are named after their files.
8. **Tempo**: the ♩ value in the top bar is the sketch's tempo. It is detected from the first recording's notes
   once they are transcribed (until then, a sketch recorded with a count-in has the count-in's tempo). Tap it
   to change it: type a value, use − / +, drag the slider, or tap along; play the sketch from there and a click
   sounds on the beat so you can match it by ear. *Detect again* re-reads the first track; the playback speed
   (1×, 0.75×, 0.5×) is set there too. When you record another track, the count-in runs at the sketch's tempo,
   the other tracks start on a beat, and a dot near the bottom of the recording screen flashes on each beat
   (silently, so the microphone does not pick it up).
9. **Share**: the share button (or swiping a sketch left in the list) asks which files to include: the
   **video** (original take), the **recorded audio** on its own, the **notes audio** (the transcription played by
   the built-in piano) and **MIDI**. Then it opens the iOS share sheet, or a folder picker on desktop. For a
   sketch with several tracks, the recorded audio and the notes audio are the tracks you hear mixed together
   (muted tracks left out), the MIDI file has one MIDI track per track, and the video is the take shown in the
   sketch.
10. **Organise**: in the list, swipe a sketch left for *Share* / *Delete*; press and hold to select several, then
   share or delete them together.
11. **Apple Watch**: record on the Watch and the take arrives here as a sketch tagged *Apple Watch*. Pair once
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
  lib/music/                 Chords, key, voicings (piano, guitar), MIDI, summaries, note helpers, synth
  lib/playback/              Web Audio playback engine, take decoding, time stretch, video follower
  lib/library/               Sketch Library client (Tauri) + in-memory dev backend
  lib/pipeline/              Background processing queue
  lib/export/                Share/export: picks and prepares files per sketch
  lib/vision/                Future visual analysis / fusion interfaces
  lib/state/                 App state and the capture flow
  lib/watch/                 Receiving recordings from the Apple Watch app
  lib/samples/               Sample library: settings, cutting from recordings, rendering, the sampler voice
  lib/ui/                    Components (notebook canvas, minimap, rhythm pads, recorder, sketch view, piano roll,
                             sample library and editor…), the space bar and page zoom (transport.ts)
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
(cd src-tauri && cargo test)         # Sketch Library, Watch receiver (pairing, transfers over TCP, import), iOS plist keys
```

End-to-end smoke tests (optional, need Playwright's Chromium or `tauri-driver`):

```bash
node scripts/make-test-audio.mjs /tmp/chords.wav
```

```bash
SMOKE_WAV=/tmp/chords.wav npm run smoke:browser   # with `npm run dev` running
```

```bash
npm run smoke:playback   # scrub, play, crop, loop; four tracks on one clock, Separate, chord strip (needs `npm run dev`)
```

```bash
npm run smoke:edit       # drag-select, move, transpose, delete, join and undo notes on the ?demo sketch
```

```bash
npm run smoke:notebook   # the canvas: sketches on one clock, gestures, the sketch menu (volume, slice, delete), repeats, the loop (ruler handles, playback inside it), export, copy/paste, the rhythm view, text notes, notebooks, the Reference section
```

```bash
npm run smoke:listen     # saved Take/Notes/Both choice, canvas audio and preview, cropped repeats (needs npm run dev)
```

```bash
npm run smoke:samples    # space bar, a fresh audio context after the page was hidden, the always-editing roll and its auditions, waveform → library, Use sample, the library and editor, the rhythm view (four pads, bars side by side, a pad's sample), guitar previews, page zoom
```

On this branch `smoke:browser` records from the canvas and opens the sketch with a double-tap, and `smoke:playback`
and `smoke:edit` open the demo notebook's first sketch; the four-track part of `smoke:playback` is gone with the
tracks.

`npm run smoke:tauri` drives the real desktop app (Rust, SQLite, IPC, asset protocol) through WebDriver on
Linux; the header of `scripts/tauri-webdriver-smoke.mjs` explains the setup. **Not updated on this branch:**
`smoke:tauri` and `smoke:watch` still look for the old list's cards (and `smoke:tauri` for the media elements
used before the Web Audio player), so both fail at that step.

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
- **Tracks on iOS** have not been tried on a device. The other tracks play through the web view's audio (Web
  Audio) while the native recorder runs; the recording audio session is mixable (`.mixWithOthers`), so this should
  work, but it is unconfirmed. How well a new track lines up depends on how precisely the app knows when the
  recorder started; if one sits early or late, use the track menu's *Line up*. Without headphones the other
  tracks are recorded into the new one.
- **Playback** decodes each take into memory before it plays (about 11 MB per minute of mono audio). On iOS a
  take with video is read from its audio track, extracted once by AVFoundation. The first play of a long take can
  show *loading…* for a moment. Slowed playback (0.75×, 0.5×) is stretched by the app (WSOLA), which may sound
  less smooth than the system's own time stretching that the web view used before.
- **Chords section**: the key and chords come from the transcription, so they share its errors (a missed or
  ghost note can change a chord's name). Key detection assumes tonal music and can confuse a key with its
  relative major or minor; the alternative is shown when they are close. Guitar shapes are searched, not taken
  from a chord book: the common open and barre shapes come out as usual, rarer chords may get unusual
  fingerings.
- **Background recording** is not supported: iOS stops the camera when the app leaves the foreground. The take
  up to that point is saved automatically.
- **Apple Watch**: Wi-Fi and Bluetooth delivery need Earbud open on the receiving device. watchOS may block the
  Watch's direct Wi-Fi connections (Apple TN3135); the Watch then falls back to Bluetooth or its paired iPhone.
  See [watch-app/README.md](watch-app/README.md).
- **Tempo detection** assumes a steady beat. It is tested on synthesized playing (steady, with up to 30 ms of
  timing spread) and on random notes (rejected), not yet on real recordings. Rubato or free playing gets no
  tempo (set one by hand), and a tempo can come out at double or half speed; the editor fixes both.
- No notation or quantization yet. MIDI is exported in real time (120 BPM header).
- **Notebook canvas (this branch)** has been used with a mouse and through scripted pointer events in Chromium,
  not yet with fingers on an iPhone, where long presses, pinches and the pads' timing need checking. The canvas
  decodes every recording in the open notebook into memory to play them (about 11 MB per minute of mono audio),
  which limits how much a notebook can hold on a phone. Only the visible part of each sketch is drawn.
- **Repeats** of a recording join with the engine's 8 ms fades where the playing part is trimmed (after a count-in
  or at a crop), which can be heard as a small dip on sustained sound. The repeat count is whole passes only.
- **Overlapping sketches**: the one drawn on top (the later in the list) takes taps and holds; move it away to reach
  the one underneath.
- **Canvas playback on iPhone and Mac** was reported silent and could not be reproduced here: in Chromium the canvas
  plays (output measured), also right after recording onto it. The likely cause on iOS is that the canvas's audio
  context stays alive while the native recorder takes the audio session; the canvas now starts a fresh one in the
  next tap after a recording or a return from the background. Not yet confirmed on a device; if it is still silent,
  the `[canvas]` lines in Settings → Diagnostics say what the audio context was doing.
- **iPad trackpad**: two-finger scrolling on the canvas went along the wrong axis on an iPad in landscape (the
  problem found in Snorkle). `src-tauri/Info.ios.plist` now has the fix used there: UIKit's native indirect input
  (`UIApplicationSupportsIndirectInputEvents`) and a single-window scene with Tao's scene delegate
  (`UIApplicationSceneManifest`, Tao 0.37.2 here as in Snorkle). It only takes effect in a new iOS build, and has not
  been tried on an iPad with Earbud; see [docs/IOS.md](docs/IOS.md#ipad-trackpad).
- **Recording onto the canvas** shows no camera image (the camera still records when Settings asks for it). On iOS
  the camera preview layer still sits behind the page while recording, hidden by the canvas; this has not been
  tried on a device.
- **Slice and volume** work on the canvas only: a sliced recording's halves are crops (the sketch view shows the
  whole take with the crop handles), and the sketch view plays at full volume.
- **Text notes**: links in notes are shown but not followed (a tap on the canvas is a canvas gesture). Notes are not
  exported with sketches.
- **Samples** play notes by resampling (like a classic sampler), so a note far from the sample's root sounds faster
  or slower and its timbre (formants) moves with it; there is one sample per sound, not one per range of notes. A
  sound without a steady pitch (a drum, noise) gets no root (C4 is assumed). Pitch detection (YIN) is tested on
  synthesized tones, not on real recordings yet. Samples are mono. The editor's effects are rendered offline when the
  sample plays (a reverb adds its tail), so the first play after a change of a long sample can take a moment.
- **Audio after the background**: every view now makes a fresh audio context in the next tap after the page was
  hidden (or after a context that ran was suspended or interrupted by the system). In Chromium this is simulated with
  a visibility change; that it cures the silent play on an iPhone is not confirmed yet.
- **Page zoom** is blocked with the viewport (`user-scalable=no`, honoured by the iOS app's web view; Safari in a
  browser ignores it for accessibility), `touch-action: pan-x pan-y` on the page, WebKit's gesture events, two-finger
  touch moves, ctrl + wheel and ⌘/Ctrl + − = 0. The canvas and piano rolls zoom with their own pinch and wheel handling.
- **Guitar previews** are recordings of one guitar (Fluid R3, see `public/sounds/guitar/README.md`); chords tapped on
  the circle of fifths and recorded as a sketch are still played by the built-in piano.
- **Rhythm sketches**: tempo detection from taps needs about eight taps on a
  steady beat; with fewer, the median gap between taps is taken as the beat (folded into 70–160 BPM) and can be off
  by double or half, which the editor's tempo fixes. Only 4/4 and 16th notes.

## License

MIT for Earbud's own code. Basic Pitch (model and library) is Apache-2.0, © Spotify AB. The guitar samples in
`public/sounds/guitar/` come from the Fluid (R3) General MIDI SoundFont by Frank Wen (MIT), as rendered by
[MIDI.js Soundfonts](https://github.com/gleitz/midi-js-soundfonts) (CC BY 3.0).
