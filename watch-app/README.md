# Earbud for Apple Watch

A small companion app: tap to record on the Watch, and the recording is sent to a device running
Earbud (iPhone, iPad or Mac), where it becomes a sketch and is transcribed like any other.

It uses the pairing protocol from [Woods Whisper](https://github.com/laffan/woods-whisper): the
receiving device shows a 5-digit code, you type it on the Watch, and from then on the Watch shows
**which device its recordings go to** ("Sends to Studio iPhone") and stamps a secret on every
transfer, so no other device on the network can push recordings into Earbud.

> **Status.** None of the Swift here has been compiled. The environment this was written in has
> no macOS or Xcode. A syntax parser passes every file, and the Rust side of the protocol is
> tested end to end. Expect the first Xcode build to need small fixes. See
> [What to check on a device](#what-to-check-on-a-device).

## Layout

```
watch-app/
  project.yml                 XcodeGen spec for the Watch app
  EarbudWatch/                SwiftUI app: recorder, recordings list, pairing, settings
  Packages/EarbudLink/        the protocol, shared with Earbud's iOS receiver
```

Receiving side, in the Earbud app:

```
src-tauri/src/watch_link/          Rust: Wi-Fi receiver, pairing, inbox → sketches (every platform)
plugins/tauri-plugin-watch-link/   Swift (iOS): Bluetooth and paired-iPhone receivers
src/lib/watch/                     UI state; Settings → Apple Watch
```

## Build and install

You need a Mac with Xcode, an Apple Watch paired with an iPhone, and
[XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
brew install xcodegen
```

```bash
cd watch-app && xcodegen
```

```bash
open EarbudWatch.xcodeproj
```

1. In the project settings (or in `project.yml` before running `xcodegen`), set your team as
   `DEVELOPMENT_TEAM`. Use the same team as the Earbud iPhone app.
2. The Watch app's bundle id is `com.earbud.sketchbook.watchkitapp`. It is derived from
   `EARBUD_COMPANION_BUNDLE_ID` in `project.yml`, which must equal Earbud's `identifier` in
   `src-tauri/tauri.conf.json`. If you changed that (`docs/IOS.md` suggests it when signing
   complains), change `EARBUD_COMPANION_BUNDLE_ID` to match and run `xcodegen` again.
3. Choose the **EarbudWatch** scheme and your Watch as the destination, then Run. The Watch must
   have Developer Mode on (Watch: Settings → Privacy & Security → Developer Mode), and the first
   install over the iPhone can take several minutes.

The Watch app is built as an independent app (`WKRunsIndependentlyOfCompanionApp`), so it
installs without being embedded in the Tauri-built iPhone app.

## Use

1. **On the receiving device** (Earbud on iPhone, iPad or Mac): Settings → **Apple Watch** →
   *Pair Apple Watch*. That switches receiving on and shows a 5-digit code for two minutes.
   Optionally rename the device first ("Name shown on the Watch").
2. **On the Watch**: Earbud → *Pair with Earbud* (or the gear → *Pair with a code*), and type the
   code. The Watch looks for the device over Wi-Fi and Bluetooth at the same time; whichever
   answers first is saved.
3. **Record**: tap the red button, play, tap stop. With *Send automatically* on (the default), the
   recording is sent straight away. The list shows each recording's state: *Sent to …*,
   *Sending 40%*, *Waiting for …* (queued through the iPhone), or *Not sent* (open it to retry).
4. **In Earbud**, the recording appears in the list with an *Apple Watch* tag, dated when it was
   recorded, and is transcribed.

Recordings stay on the Watch until you delete them (swipe left, or Settings → *Delete sent*).

**Keep Earbud open on the receiving device** while the Watch sends over Wi-Fi or Bluetooth. iOS
suspends apps in the background, and with them the receivers.

## How a recording travels

| Route | When | Notes |
| --- | --- | --- |
| **Wi-Fi** (TCP) | Both on the same network, or the Watch on the iPhone's Personal Hotspot | Fast. Works with a Mac receiver too. See the watchOS caveat below. |
| **Bluetooth LE** | Within a few metres of an iPhone or iPad running Earbud | No network needed. Slower: roughly 15–40 s per minute of *Full* quality audio (an estimate, not measured). |
| **Paired iPhone** (WatchConnectivity) | The receiving device is the Watch's own iPhone | watchOS queues the file and delivers it when it can, even if Earbud isn't open; Earbud adds it when it next opens. |

When sending, the Watch tries the route that answered the pairing code first, then the others
this pairing supports. It goes through the paired iPhone only when that iPhone's Earbud has
announced itself with the **same device id** as the paired device, so a recording never goes to
a different device than the one shown.

If the paired iPhone runs Earbud, its name appears in the Watch's Settings as *Send to … (this
Watch's iPhone)*, which pairs without a code (paired-iPhone route only).

### watchOS and Wi-Fi

watchOS allows direct TCP connections (Network framework) only in specific cases: audio streaming,
VoIP calls, and a tvOS discovery case ([TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)).
Outside those, a connection waits with "network is down", and the simulator does not enforce
this. Woods Whisper uses the same Wi-Fi path, and this app gives up on it within seconds and
moves on to Bluetooth or the paired iPhone, so a blocked Wi-Fi route costs a few seconds rather
than a failed send. Whether Wi-Fi is usable on your Watch is one of the things to check on a
device.

## Protocol

The [Woods Whisper protocol](https://github.com/laffan/woods-whisper/blob/main/docs/CONNECTIVITY.md)
with Earbud's own identifiers, so the two apps never answer each other:

| | Woods Whisper | Earbud |
| --- | --- | --- |
| TCP port | 50710 | **50720** |
| BLE service | `8C3E5B40-…` | **`0C849000-8B01-4F56-A535-7850AA4E0EAC`** (RX `…9001…`, TX `…9002…`) |
| Bonjour | `_woodswhisper._tcp` | none (the Watch can't browse; the receiver doesn't advertise) |

**Pairing.** The receiver opens a 2-minute window with a random 5-digit code. The Watch sweeps its
subnet on the fixed port (Personal Hotspot gateway `172.20.10.1` and each `.1` first, batches of
16, 1.2 s per host) while scanning for the BLE service. A receiver whose window is open and whose
code matches replies with `PairingResponse {displayName, token, port, deviceId}`; others reply
with a refusal. The window closes after one successful pairing, after two minutes, or after 20
wrong codes.

**TCP frames** (one message per connection):

```
recording: [0x01][u32 BE headerLen][RecordingTransfer JSON][audio]   → [1 byte: 1 accepted, 0 refused]
pairing:   [0x02][u32 BE len][PairingRequest JSON]                   → [ack] + if 1: [u32 BE len][PairingResponse JSON]
```

**Bluetooth:** the same messages in an envelope `[type][u32 BE len][body]`, written to RX without
response in chunks and reassembled; replies come as TX notifications: `0x11` ack, `0x12` pairing
response.

**JSON** (ISO-8601 dates, sorted keys):

```json
RecordingTransfer  {"byteCount":48213,"pairingSecret":"…","recording":{"createdAt":"2026-11-11T18:04:05Z","duration":12.5,"fileExtension":"m4a","id":"E621E1F8-…","mimeType":"audio/mp4","name":"Nov 11, 10:04 AM"},"senderName":"Apple Watch"}
PairingRequest     {"code":"04217","deviceName":"Apple Watch"}
PairingResponse    {"deviceId":"…","displayName":"Studio iPhone","port":50720,"token":"…"}
```

Example messages live in `Packages/EarbudLink/Tests/EarbudLinkTests/Fixtures/` and are decoded
by both the Swift tests and the Rust tests (`src-tauri/src/watch_link/tests.rs`).

**Paired iPhone:** `WCSession.transferFile` with metadata `["transfer": RecordingTransfer]`. Earbud
on the iPhone publishes `{"deviceId","displayName"}` in the application context under
`earbudReceiver`.

**Receiving.** Every route writes `<id>.m4a` and then `<id>.json` into `library/inbox/`. Earbud
imports each entry as a sketch whose id is the recording's UUID, so a recording delivered twice
(an acknowledgement lost, then resent) is imported once.

## Recording

AAC `.m4a`, mono, chosen in Settings → Quality:

- **Full**: 44.1 kHz, high quality (about 1 MB a minute).
- **Compact**: 22.05 kHz, medium quality, about a third of the size. Earbud transcribes at
  22.05 kHz, so transcription is not affected. Useful over Bluetooth.

The `audio` background mode keeps recording when you lower your wrist. A call or Siri interrupts
the recording; what was recorded is kept.

## Tests

```bash
cd watch-app/Packages/EarbudLink && swift test    # on a Mac: framing, JSON fixtures, inbox writer
```

```bash
cd src-tauri && cargo test watch_link             # anywhere: pairing and transfers over real TCP
```

### Without a Watch

`scripts/fake-watch.mjs` speaks the Wi-Fi protocol from a computer, which is enough to check Earbud's
receiver on a Mac, PC or iPhone (same network) before the Watch app builds:

```bash
npm run fake-watch -- pair <receiver ip> <code>
```

```bash
npm run fake-watch -- send <receiver ip> recording.m4a
```

The receiver's addresses are listed under Settings → Apple Watch. `npm run smoke:watch` runs the same
steps against the desktop app through WebDriver (Linux; setup in the script's header).

## What to check on a device

1. **Build**: `EarbudLink` and the app compile (Xcode 15 or later). Likely trouble spots, if any:
   Swift 6 concurrency diagnostics (the targets use Swift 5 mode), and `AVAudioApplication`
   (watchOS 10+).
2. **Earbud on iPhone builds** with the new `tauri-plugin-watch-link`, whose Swift package depends
   on `watch-app/Packages/EarbudLink` by relative path.
3. **Pairing over Bluetooth**: with Wi-Fi off on the Watch, pair with a code. The Watch should show
   the iPhone's name; Earbud shows "Paired with …".
4. **Pairing over Wi-Fi**: Watch and receiver on the same Wi-Fi, iPhone Bluetooth off. Pairing
   either works or fails within a few seconds with "No device showed that code". The second case
   means watchOS blocked the connection (TN3135).
5. **Sending**: a 30-second recording arrives in Earbud, plays, and gets transcribed. Note which
   route the Watch reports (open the recording: "Bluetooth, 10:42").
6. **Paired iPhone**: with Earbud closed on the iPhone, record on the Watch. The recording shows
   *Waiting for …*; opening Earbud adds it. This needs iOS to see the Watch app as Earbud's
   companion (Settings → Apple Watch in Earbud says whether it does).
7. **Mac**: Earbud on a Mac, pair over Wi-Fi. If the macOS firewall is on, it asks whether Earbud may
   accept incoming connections; allow it.

The Watch's Settings → *Activity* lists recent connection attempts and errors.
