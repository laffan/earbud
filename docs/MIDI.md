# Instrument workflows (midi-support)

Open a sketch’s More actions → Play with Instrument. In Earbud lists installed
AUv3 instruments; select one, choose a factory preset or parameters, or open its
native interface. Play previews it. Render as New Sketch renders its actual
output, first offline and then with a real-time mixer tap if offline rendering
fails. A configurable tail is included. Cancellation removes unfinished output.
An entirely silent output is rejected. No built-in synth is substituted.

MIDI Out lists Core MIDI endpoints and an Earbud virtual source. USB, connected
Bluetooth MIDI, and app destinations are discovered rather than hardcoded.
Playback uses native host timestamps with short lookahead. Stop releases sustain
and sends All Sound Off and All Notes Off on all channels. Destination removal,
backgrounding, interruptions and route changes stop playback. No background audio
capability is enabled: use MIDI export when switching applications.

In Logic Pro for iPad enable its virtual MIDI input, select Logic Pro Virtual In
(or the destination actually shown), and choose an instrument. Logic routing has
**not been verified on a physical device**. GarageBand compatibility is not
assumed: if it exposes no destination, use .mid file import in a compatible DAW.
Earbud cannot record another application's internal audio through the microphone.

Every outgoing workflow saves a SQLite MIDI session before transport starts.
Schema v10 adds midi_sessions, midi_provenance and sketches.audio_midi_offset_ms.
Sessions retain a MIDI BLOB, SHA-256 hash, immutable original.mid file, source
identity/title, exact editable note snapshot, tempo/track metadata, destination,
status and result identity. Editing or deleting the source does not remove it.
Pending imports are discarded and made retryable on startup. Completion commits
notes, provenance, saved sketch status and session completion in one transaction.
Original media is copied unchanged. Waveform PCM is derived separately. Known
MIDI is never sent through Basic Pitch. Original MIDI export remains immutable;
normal MIDI export includes edits/alignment. Positive alignment delays notes
relative to the recording without modifying original media or MIDI.

Use MIDI sessions to attach returned audio from Files, or receive shared audio.
Exactly one pending session is preselected; with multiple sessions choose one.
Audio-only import is also available. The destination notebook and placement can
be changed. MP3, M4A, WAV, AIFF, AAC, CAF and FLAC are supported by the native inbox,
subject to actual decoding, a 512 MB limit and one-hour duration limit.

## Native build and signing

A Mac, Xcode and appropriate provisioning are required. Swift and device behavior
have not been built or tested in this Linux environment. These sources are an
implementation pending native verification, not a claim of device readiness.

After npm ci and tauri ios init, install the Ruby xcodeproj gem and run:

```
ruby scripts/configure-ios-music.rb src-tauri/gen/apple/earbud.xcodeproj group.YOUR.earbud YOUR_TEAM_ID
```

Use an App Group registered to your team for both app and extension. The script
adds EarbudAudioShare, embeds it, sets signing and shared-group entitlements, and
sets EarbudAppGroup in the app/extension Info.plist. Check the actual project name
under src-tauri/gen/apple. Re-run after project regeneration. Extension sources
and plist templates live in ios-share-extension, outside generated directories.
No background execution entitlement is added. Build the app and extension in
Xcode; verify provisioning includes the same group for both targets.

The extension copies a security-scoped file representation while its grant is
valid, validates audio and size, streams a content hash, then atomically commits
an inbox directory in the App Group. Duplicate pending deliveries reuse the
existing item. Open/foreground Earbud to select the MIDI session. The extension
does not attempt unsupported automatic app launch. Incomplete staging is cleaned
after a day. Invalid inbox audio can be discarded; failed imports keep the source
and session retryable. Files import remains available without extension signing.

## Validation and device checklist

Automated: npm run check, npm run build, npm test; scripts/check-library.sh runs
the actual Rust library tests without a desktop webview. The normal cargo test
also checks the complete native application when GTK/WebKit development packages
are installed. Linux setup lacked these system libraries and package privileges.
The baseline notebook smoke has a timing-sensitive tempo assertion (100.1 becomes
1001 in its digits-only comparison). Do not count that run as passing.

The following checks are **unrun** and required before release, on iPhone and iPad:

1. Build/sign both targets; share MP3, WAV, M4A, AIFF and CAF from Files/DAWs with
   Earbud closed and already running. Check App Group discovery and decoding.
2. In Logic enable virtual MIDI input; send a melody, chords, repeated notes and
   overlapping notes. Check channels, velocities, tempo, stop/restart/panic and
   destination removal. Confirm foreground switching stops without stuck notes.
3. Export Logic audio; share to Earbud; choose the saved session; import; verify
   playable audio, waveform and original editable notes. Edit the source before
   return and confirm the saved version wins. Export recording and Original MIDI.
4. Repeat with multiple sessions, cancellation, restart mid-import, duplicate
   shares, invalid/empty/large files, low storage and import retries.
5. Install a real third-party AUv3. Test discovery, presets, native UI dismissal,
   generic parameters, preview/restart and rendering. Confirm audible instrument
   output, tail duration, offline failure fallback, cancellation and cleanup.
6. Verify note/audio alignment in sketch, notebook playback and MIDI/notes-audio
   export. Verify original MIDI bytes remain unchanged after edits.
7. Test camera/mic capture, count-in, normal Web Audio playback, Bluetooth/USB
   route changes, calls, orientation and foreground transitions after hosting.

Current limitations: no MIDI 2 UMP transport (MIDI 1 compatibility APIs are used),
no format-2 independent-track playback, and split/escaped SysEx playback reports
an explicit error while retaining the file for export. Native render fallback,
AU compatibility and Share Extension integration require physical-device proof.
