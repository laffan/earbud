# Earbud docs site: planning

This file plans the GitHub Pages documentation for Earbud. It does not design the site. It decides what the
docs should spend their effort on, which pages exist, and what media each page needs.

Sources read: `README.md`, `README-TECHNICAL.md`, `docs/ARCHITECTURE.md`, `docs/IOS.md`, `watch-app/README.md`,
the code under `src/lib/`, and the commit history from the MVP (2026-11-11) to the release pipeline (2026-11-17).

## 1. Pitch

Earbud is a sketchbook for piano ideas, not a production DAW. You tap once, play, and stop. Earbud keeps the
audio and video exactly as recorded, then works out on the device, without a network, what you played: the
notes, the tempo, the key, the chords, and how to play those chords on piano or guitar. Sketches sit on an
endless notebook page that plays back like a timeline, so ideas can be laid side by side, repeated, layered and
annotated instead of being filed in a list of voice memos.

Short form for the site header: *Record a piano idea. Earbud tells you what you played.*

## 2. The baseline: what a typical DAW already does

To decide what is distinctive, the comparison set is GarageBand, Logic Pro, Ableton Live, FL Studio and Reaper.
Between them, these are standard and need no persuasion in Earbud's docs:

- A multitrack timeline with tracks, mute and solo, a loop range and a count-in.
- A MIDI piano roll with select, move, resize, transpose, quantize and undo.
- A drum step sequencer with velocity and swing.
- A sampler: cut a region of audio, set its root note, trim, envelope, filter, reverb, reverse, play it
  chromatically. Logic's Quick Sampler and Ableton's Simpler both detect the root note.
- Time-stretched slow playback, a tempo editor with a click, and tap tempo.
- MIDI import and export, audio export, choosing audio input and output devices.

Audio-to-MIDI and chord detection also exist in the big DAWs, but as tools you invoke after the fact:
Ableton's *Convert Harmony to New MIDI Track* and Logic's *Chord ID* / chord track. That is the line Earbud's
docs need to draw: in Earbud these happen to every take, automatically and offline, and their results are the
centre of the app rather than an editing aid.

## 3. Distinctive features, ranked

Ranked by how far each one sets Earbud apart from the baseline above. Each entry says what it is, why it is
unusual, and what its doc page needs. Status comes from the table in `README-TECHNICAL.md`; anything not yet
confirmed on a device is marked.

### 1. Every take is transcribed, automatically and offline

**What it is.** After each recording is saved, a worker runs Spotify's Basic Pitch model (bundled, no network)
and produces a polyphonic note list: two hands, overlapping notes, chords. The original recording is never
changed; the engine's output and your edits are stored separately, and *Transcribe again* can redo it with
other settings. A failed transcription never affects the recording.

The cleanup after the model is piano-specific and room-aware (`src/lib/transcription/noteCleanup.ts`):

- **Room presets**: *Quiet*, *Normal*, *Noisy* or *Custom*, which gate quiet notes and notes without a key
  strike, so a voice or background noise produces fewer false notes.
- **Held notes**: *As detected*, *Join* or *Join more*, which reconnect a sustained note that the model split
  while other notes were played over it.

**Why it is unusual.** DAWs treat audio-to-MIDI as a one-off command on a region, with no notion of the room
it was recorded in and no piano-specific repair of held notes. Earbud makes it the default outcome of pressing
record, keeps the recording and the notes side by side, and lets you hear either (see feature 6).

**Page needs.**
- A short screen recording: tap record, play a phrase, stop, the piano roll filling in.
- Paired audio examples: the same take transcribed with *Quiet* and *Noisy*, and a held-note passage with
  *As detected* and *Join*, each with its piano roll screenshot. `scripts/make-test-audio.mjs` and the
  transcription fixtures can produce reproducible examples; a real-room recording should be added for honesty.
- The measured numbers already in `README-TECHNICAL.md` (false notes per preset on the test pieces), stated as
  synthetic-test results.
- A plain "what it gets wrong" section: ghost notes from harmonics, octave confusion, pedal-blurred note ends.

### 2. Key, chords and how to play them

**What it is.** From the notes, Earbud names the key (both candidates when two fit almost equally), the chord
progression with roman numerals, and a card for each chord used: how often and how long it is played, and how
to play it as a piano voicing (left-hand bass, right-hand chord) or as guitar shapes. Guitar shapes are
searched across the neck rather than copied from a chord book, sorted easiest first, and played back with
recorded, strummed guitar notes. A circle of fifths shows which areas of harmony a sketch covers, darker for
more time spent.

**Why it is unusual.** Logic's Chord ID can name chords in audio, but no mainstream DAW turns a recording into a
lesson: the voicing on a keyboard, every guitar shape, and where the progression sits in the key. This is
closer to a chord-detection app (Chordify, Capo) than to a DAW, applied to your own playing.

**Page needs.**
- Screenshots at phone and iPad width of the Chords tab: progression with numerals, a chord card in *Piano*
  and in *Guitar*.
- A screenshot of the circle-of-fifths coverage view for a sketch that moves between keys.
- A short audio clip of a guitar shape preview, to show that it is a strummed guitar, not a piano.
- A note on accuracy: chords inherit transcription errors; relative major and minor can be confused.

### 3. The notebook canvas instead of tracks

**What it is.** A notebook is one endless page. Left to right is time; sketches sit at any height. The playhead
plays every sketch it crosses, on one audio clock. Long-press empty space to record, import or tap a rhythm
there. Drag a sketch's right edge to repeat it. Slice a sketch into two that still share one recording.
Double-tap empty space for a markdown text note; an emoji-only note shows large and appears on the minimap.
Copy and paste work across notebooks. Each notebook remembers its zoom, scroll and loop range.

**Why it is unusual.** DAW arrangements are lanes of tracks. Earbud's README says it is "meant to feel like a
notebook, not a digital audio workstation", and the canvas is where that shows: a spatial page where ideas,
variations and written notes sit next to each other and also play as an arrangement. The commit history shows
this replaced both a chronological list and a multitrack sketch view.

**Page needs.**
- A hero GIF of the canvas: scroll, zoom, the playhead crossing three sketches and a rhythm.
- A gesture reference (the table in `README-TECHNICAL.md` is the starting point), with a short GIF per gesture
  that is not self-explanatory: drag-to-repeat, slice, copy and paste between notebooks.
- A screenshot of text notes, including an emoji note on the minimap.
- The `?demo` notebook gives a consistent scene for all of these.

### 4. Capture first, with the video of your hands

**What it is.** One tap records. On iPhone and iPad the camera records synchronized video (back camera, or
*Ultra wide* to fit the keyboard) alongside the audio, so a sketch keeps how it was played as well as how it
sounded. On the canvas, recording happens in place: a red strip grows where the sketch will go, with the
count-in, the input level, and a beat dot when recording over a rhythm. After the count-in the canvas plays
from that point so you can play over what is there, and the new sketch is placed so its downbeat lands where
you heard it, with output latency taken off. Recording is saved immediately, with crash recovery.

**Why it is unusual.** DAWs record audio into armed tracks; video, if supported at all, is something you import
to score against. Keeping the performer's video as part of the take, and placing an overdub by where you heard
the page rather than on an armed track, are both specific to Earbud's purpose. The deferred finger-tracking
interface (`src/lib/vision/`) is built on this video and could be mentioned as direction, not as a feature.

**Page needs.**
- A photo of the setup: a phone propped above the keys.
- A screenshot of the sketch view with the video under the piano roll.
- A GIF of recording onto the canvas over an existing sketch.
- Clear device status: iOS capture runs on one device so far; recording onto the canvas has not been tried on
  a device.

### 5. Rhythms from tapped pads

**What it is.** *Record rhythm* gives four pads (kick, snare, hat, clap; keys 1 2 3 4 or J K L ;). You tap a
groove; Earbud detects the tempo from the taps, takes the beat nearest the first tap as bar 1, snaps every tap
to a 16th, and works out how many bars you played (dropping a lone downbeat at the end as the loop coming
round). The result is an editable step pattern that sits on the canvas.

**Why it is unusual.** DAWs record pad hits against a tempo you set first. Earbud infers the tempo and the bar
grid from free tapping. The full rhythm view after that (steps, velocity, swing, samples on pads) is standard
and can be described briefly.

**Page needs.**
- A GIF: tapping the pads, pressing *Done*, the pattern appearing in the sequencer.
- An audio example of the tapped input and the quantized result.
- The limits: about eight steady taps needed; 4/4 and 16th notes only; tempo can come out double or half.

### 6. Hearing the take, the notes, or both

**What it is.** Each sketch has a *Take / Notes / Both* choice: the recording, the transcription played by the
built-in piano (or a sample), or both together. It is saved per sketch and also decides how the sketch plays
and looks on the canvas (waveform, or a miniature piano roll). In the piano roll every edit is heard: moving or
resizing notes auditions what is under the playhead.

**Why it is unusual.** In a DAW, audio and its converted MIDI are separate tracks you manage yourself. Earbud
treats them as two views of one take, which is how you check and correct a transcription by ear.

**Page needs.**
- A short clip of the same phrase in *Take*, *Notes* and *Both*.
- A GIF of fixing a wrong note and hearing it change.

### 7. Recording chords from the circle of fifths

**What it is.** In the Reference section, the circle of fifths has a record button: tap chords on the circle
and they become a new sketch, titled after the progression (for example *C – Am – F – G*), using the piano
voicing or guitar shape you last heard for each.

**Why it is unusual.** It is a way to write a progression without playing it, from a theory diagram. DAW chord
tools (Logic's chord track, Ableton 12's scale tools, Scaler) exist, but recording straight from a circle of
fifths is uncommon.

**Page needs.** One GIF of tapping a progression and the sketch appearing on the canvas. Could share a page with
the Reference section.

### 8. The Apple Watch companion

**What it is.** Record on the Watch and the take arrives as a sketch at the end of the open notebook on a paired
iPhone, iPad or Mac, then is transcribed like any other. Pairing uses a 5-digit code and a shared secret, over
Wi-Fi, Bluetooth or the paired iPhone.

**Why it is unusual.** Riff-recorder apps have Watch recording; DAWs do not. It belongs to the same capture-first
idea.

**Page needs.** Pairing screenshots from the Watch and the phone. **Status matters here**: none of the Watch Swift
has been compiled yet, so this page should wait or be clearly marked as coming.

## 4. Standard features: brief mention only

These should appear in a features list or the reference pages, a line or two each, without dedicated pages:

- Piano roll editing: select, move, resize, transpose, join split notes, undo, revert to the transcription.
- Rhythm view: 16-step bars, velocity, swing, tap tempo, record pads into the loop, undo.
- Sample library and editor: cut from a waveform, trim, envelope, level, tone, reverb, transpose, reverse,
  detected root note; pads and a sketch's notes can play a sample.
- Tempo detection and tempo editor with click; slowed playback (0.75×, 0.5×).
- Crop and loop within a sketch; loop range on the canvas; minimap.
- Import audio or MIDI; export video, recorded audio, notes audio and MIDI (rhythms as General MIDI drums).
- Separate microphone and output selection.
- Space bar plays whatever is in front.
- Offline operation and local storage (SQLite and files).

Two items sit in between and could get a short paragraph on a "how Earbud is built" page rather than a feature
page: the non-destructive storage model (original never modified, engine output and edits stored separately,
hard-linked copies), and one-clock playback of everything on the canvas.

## 5. Proposed site structure

```
Home                      pitch, hero GIF of the canvas, download buttons, three-line "what's different"
Get started
  Install                 per OS, the unsigned-build steps from README.md
  Your first sketch       record, see the notes and chords, play it back, export
What Earbud does
  Transcription           feature 1, with room presets and held notes
  Chords and key          feature 2
  The notebook            feature 3
  Recording               feature 4, including video and recording onto the canvas
  Rhythms                 feature 5, plus a short section on the rhythm view
  Take, notes or both     feature 6, plus piano roll editing
  Reference               feature 7, chord pages and circle of fifths
  Samples                 standard; one page, short
Platforms
  iPhone and iPad         from docs/IOS.md, user-facing parts only (setup, permissions, audio routing)
  Apple Watch             feature 8, once it has been built
  Desktop                 macOS, Windows, Linux notes (Linux playback, output selection limits)
Reference
  Gestures and keys       the canvas gesture table, keyboard shortcuts
  Settings                every setting, one line each
  Export formats          what each export contains
  Limitations             known limitations, written for users
For developers            links to README-TECHNICAL.md, docs/ARCHITECTURE.md, building from source
```

Twenty-odd pages; the eight under *What Earbud does* carry most of the effort and most of the media.

## 6. Media plan

- **Screenshots and GIFs from the browser build.** `npm run dev` with `?demo` gives a repeatable notebook, and the
  Playwright smoke scripts already drive the canvas, rhythm view and sample library at phone and iPad sizes. A
  script that walks through those states and saves screenshots would keep images current as the UI changes.
- **Device captures.** The video-of-hands workflow, the Watch, and anything touch-specific need recordings on a
  real iPhone or iPad. Those have to be made by hand.
- **Audio examples.** Short MP3 clips, each with its piano roll image: transcription presets, held-note joining,
  Take / Notes / Both, tapped rhythm before and after quantizing, a guitar shape preview.

## 7. Open questions for Nate

1. **"DAW" or "sketchbook".** The README says Earbud is "meant to feel like a notebook, not a digital audio
   workstation". Should the site avoid the word DAW and compare itself to voice memos and chord apps instead, or
   position it as a different kind of DAW?
2. **Unconfirmed features.** Much of the notebook canvas, the Watch app and iOS audio routing have not been run on
   a device. Document them now with a status label, or leave them out until confirmed?
3. **Tracks.** Multitrack sketches still exist in storage and the capture flow but are hidden in the canvas UI.
   Should the docs mention tracks at all?
4. **Stale wording.** `README-TECHNICAL.md` still says "this branch" for the canvas and describes the older list
   UI under *Using Earbud*, though the canvas is now on `main`. Fix that before or alongside the docs?
5. **Where the site lives.** `docs/` already holds `ARCHITECTURE.md` and `IOS.md`, so publishing Pages from
   `docs/` would mix developer files into the site. Options are a separate folder (for example `site/`) built by
   an Actions workflow, or a `gh-pages` branch. Is there a preference, and should all four apps share one
   approach and look?
6. **Audience.** Piano players who will never build from source, or also developers? This decides whether the
   developer section is a link or a set of pages.
7. **Device media.** Can you record the iPhone and Watch footage, or should the first version use browser-build
   captures only?
