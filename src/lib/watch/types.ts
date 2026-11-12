/**
 * Apple Watch link: types shared by the client and the UI.
 *
 * The Watch app (`watch-app/`) records audio and sends it to a device running
 * Earbud. Rust runs the local-network receiver and imports what arrives
 * (`src-tauri/src/watch_link`); on iOS the `watch-link` plugin adds Bluetooth
 * and the paired-iPhone route (WatchConnectivity).
 */
import type { Sketch } from '../library/types';

/** `captureBackend` of sketches recorded on the Watch. */
export const WATCH_CAPTURE_BACKEND = 'apple-watch';

export interface PairedWatch {
  name: string;
  /** `localNetwork` | `bluetooth` | `phoneSession` */
  via: string;
  pairedAt: number;
}

export interface WatchLinkStatus {
  /** Receiving over Wi-Fi (and Bluetooth on iOS) is on. */
  enabled: boolean;
  /** The local-network server is accepting connections. */
  listening: boolean;
  port: number;
  /** The name the Watch shows as the destination. */
  displayName: string;
  nameIsDefault: boolean;
  deviceId: string;
  /** Handed to the native receivers; never shown. */
  secret: string;
  addresses: string[];
  pairing: { code: string; expiresAt: number } | null;
  pairedWatches: PairedWatch[];
  error: string | null;
  inboxDir: string;
}

/** iOS only: Bluetooth and WatchConnectivity. */
export interface NativeWatchStatus {
  /** `poweredOn`, `poweredOff`, `unauthorized`, `unsupported`, `resetting`, `starting`, `off` */
  bluetooth: string;
  phoneSessionSupported: boolean;
  phoneSessionActivated: boolean;
  /** An Apple Watch is paired with this iPhone. */
  watchPaired: boolean;
  /** iOS reports the Earbud Watch app as installed on it. */
  watchAppInstalled: boolean;
  deviceModel: string;
  inboxDir: string;
  pendingInInbox: number;
}

export interface ImportReport {
  imported: Sketch[];
  duplicates: number;
  failed: string[];
}

/** Events from Rust (`watch-link` Tauri event). */
export type WatchLinkEvent =
  | { kind: 'paired'; watchName: string; via: string }
  | { kind: 'received'; name: string; sender: string | null; via: string }
  | { kind: 'imported'; sketches: Sketch[] }
  | { kind: 'error'; message: string };

/** Events from the iOS plugin's channel. */
export type NativeWatchEvent =
  | { kind: 'received'; name: string; sender: string; via: string }
  | { kind: 'paired'; watchName: string; via: string }
  | { kind: 'bluetooth'; state: string }
  | { kind: 'log'; message: string };

export interface NativeStartArgs {
  inboxDir: string;
  displayName: string;
  deviceId: string;
  secret: string;
  /** Advertise over Bluetooth (follows the "receive" switch). */
  bluetooth: boolean;
}

/** Everything the app needs from the platform, so it can be faked in tests. */
export interface WatchLinkClient {
  status(): Promise<WatchLinkStatus>;
  setEnabled(enabled: boolean): Promise<WatchLinkStatus>;
  setName(name: string): Promise<WatchLinkStatus>;
  beginPairing(): Promise<WatchLinkStatus>;
  endPairing(): Promise<WatchLinkStatus>;
  recordPairing(watchName: string, via: string): Promise<WatchLinkStatus>;
  reset(): Promise<WatchLinkStatus>;
  /** After returning to the foreground: reopen the listening socket. */
  resume(): Promise<WatchLinkStatus>;
  importInbox(): Promise<ImportReport>;
  listen(handler: (event: WatchLinkEvent) => void): Promise<() => void>;

  /** Whether the iOS plugin (Bluetooth, WatchConnectivity) exists here. */
  nativeAvailable(): Promise<boolean>;
  startNative(args: NativeStartArgs, onEvent: (event: NativeWatchEvent) => void): Promise<NativeWatchStatus>;
  stopNative(): Promise<NativeWatchStatus>;
  nativeBeginPairing(code: string, durationMs: number): Promise<NativeWatchStatus>;
  nativeEndPairing(): Promise<NativeWatchStatus>;
  nativeStatus(): Promise<NativeWatchStatus>;
}
