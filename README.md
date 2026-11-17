# Earbud

A small, offline-first sketchbook for capturing piano ideas. Record a take and
Earbud keeps the original audio and video, transcribes the notes and chords
in the background, and shows the key, the chords and how to play
them on piano or guitar. Sketches sit on an endless notebook canvas that plays
back like a timeline; you can correct notes on a piano roll, tap out rhythms,
add text notes, and export the recording and a MIDI file. Everything works
without a network. Runs on macOS, Windows, Linux and iPhone/iPad.

## Installation

Download the installer for your system from the
[Releases](../../releases) page: `.dmg` (macOS), `.msi` or `.exe` (Windows),
`.AppImage` or `.deb` (Linux).

The builds are not code-signed. On macOS, if the app is blocked on first
launch, move it to Applications and run:

```sh
xattr -cr "/Applications/Earbud.app"
```

On Windows, choose "More info" then "Run anyway" when SmartScreen warns.

### Build from source

Requires [Node.js](https://nodejs.org/), [Rust](https://rustup.rs/) and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri build    # installers end up in src-tauri/target/release/bundle/
npm run tauri dev      # run in development
```

## More detail

[README-TECHNICAL.md](README-TECHNICAL.md) covers every feature, the status of
each, the project layout, testing and known limitations.
[docs/IOS.md](docs/IOS.md) has the iPhone and iPad build steps.
