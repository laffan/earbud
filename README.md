# Earbud — Dettato test branch

This branch uses Dettato for new recordings, audio imports and **Transcribe again**.

## Standalone iPhone and iPad

The iOS app bundles Dettato’s pitched-note network and runs it on the device in a Web Worker. You can record, transcribe, edit and export MIDI in airplane mode. The branch includes the model weights. Build and sign the app on your Mac. [Build and device test instructions](docs/IOS.md#bundle-dettato-for-offline-transcription)

## Try it on a computer

Requires Node.js 22.12+ and Python 3.10+ in an activated virtual environment. From the repository root, run:

```sh
python -m pip install "git+https://github.com/kobimusic/dettato@9b724251794f2bbd5eaa43e54734e5a251829130"
python scripts/dettato-server.py
```

Leave the helper running. In a second terminal:

```sh
npm ci
npm run dev
```

Open http://localhost:1420, record or import a short piano phrase, then open its piano roll and export MIDI. The first take downloads the model weights from Hugging Face. CPU inference can take a minute or more. After the weights are cached, you can run offline. Browser sketches disappear on reload. Desktop Tauri builds also require the local helper.

Earbud sends its mono analysis WAV to the loopback helper and combines all pitched instruments into its editable piano roll. Instrument assignments and drums are omitted from the sketch and exported MIDI. Cancelling discards the result. An inference already running in Python finishes before the next take starts.

## Main branch and released builds

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
