/**
 * Receiving recordings from the Apple Watch app.
 *
 * Owns the receiver's state for the UI (name, pairing code, paired watches,
 * Bluetooth state) and keeps the Rust receiver and the iOS plugin in step:
 * the identity (name, id, secret) lives in Rust; the plugin is restarted with
 * it whenever it changes.
 */
import type { Sketch } from '../library/types';
import { errorMessage } from '../platform/tauri';
import type {
  NativeWatchEvent,
  NativeWatchStatus,
  WatchLinkClient,
  WatchLinkEvent,
  WatchLinkStatus,
} from './types';

export interface WatchReceiverHooks {
  /** New sketches from the Watch (add to the list, transcribe). */
  onSketches(sketches: Sketch[]): void;
  toast(message: string, kind?: 'info' | 'error'): void;
}

export class WatchReceiver {
  status = $state<WatchLinkStatus | null>(null);
  native = $state<NativeWatchStatus | null>(null);
  nativeAvailable = $state(false);
  log = $state<string[]>([]);

  private unlisten: (() => void) | null = null;

  constructor(
    private readonly client: WatchLinkClient,
    private readonly hooks: WatchReceiverHooks,
  ) {}

  async init() {
    this.unlisten = await this.client.listen((event) => this.onEvent(event));
    this.nativeAvailable = await this.client.nativeAvailable();
    this.status = await this.client.status();
    await this.syncNative();
    // iOS only reports the model ("iPhone", "iPad") as the device name; Rust's
    // default is "iPhone", so an iPad gets its own default here.
    const model = this.native?.deviceModel;
    if (this.status.nameIsDefault && model && model !== this.status.displayName) {
      await this.rename(model);
    }
    await this.importInbox();
  }

  dispose() {
    this.unlisten?.();
    this.unlisten = null;
  }

  // ------------------------------------------------------------ actions

  async setEnabled(enabled: boolean) {
    this.status = await this.client.setEnabled(enabled);
    await this.syncNative();
  }

  async rename(name: string) {
    this.status = await this.client.setName(name);
    await this.syncNative();
  }

  /** Show a code for the Watch. Turns receiving on. */
  async beginPairing() {
    this.status = await this.client.beginPairing();
    await this.syncNative();
    const pairing = this.status.pairing;
    if (pairing && this.nativeAvailable) {
      await this.client
        .nativeBeginPairing(pairing.code, Math.max(0, pairing.expiresAt - Date.now()))
        .then((native) => (this.native = native))
        .catch((error) => this.addLog(`Bluetooth pairing: ${errorMessage(error)}`));
    }
  }

  async endPairing() {
    this.status = await this.client.endPairing();
    if (this.nativeAvailable) {
      await this.client
        .nativeEndPairing()
        .then((native) => (this.native = native))
        .catch(() => {});
    }
  }

  /** New secret: every paired watch has to pair again. */
  async reset() {
    this.status = await this.client.reset();
    await this.syncNative();
  }

  /** The app is in the foreground again. */
  async resume() {
    this.status = await this.client.resume();
    if (this.nativeAvailable) {
      this.native = await this.client.nativeStatus().catch(() => this.native);
    }
    await this.importInbox();
  }

  async refresh() {
    this.status = await this.client.status();
  }

  /** Import whatever is waiting in the inbox (Bluetooth, paired iPhone, or missed earlier). */
  async importInbox() {
    try {
      const report = await this.client.importInbox();
      this.added(report.imported);
      for (const message of report.failed) {
        this.addLog(`import failed: ${message}`);
        this.hooks.toast(`A recording from the Watch could not be added: ${message}`, 'error');
      }
    } catch (error) {
      this.addLog(`import failed: ${errorMessage(error)}`);
    }
  }

  // ------------------------------------------------------------- events

  /** Events from Rust. */
  private onEvent(event: WatchLinkEvent) {
    switch (event.kind) {
      case 'paired':
        this.addLog(`paired with ${event.watchName} (${event.via})`);
        this.hooks.toast(`Paired with ${event.watchName}.`);
        void this.refresh();
        if (this.nativeAvailable) void this.client.nativeEndPairing().catch(() => {});
        break;
      case 'received':
        this.addLog(`received “${event.name}” via ${event.via}${event.sender ? ` from ${event.sender}` : ''}`);
        break;
      case 'imported':
        this.added(event.sketches);
        break;
      case 'error':
        this.addLog(event.message);
        this.hooks.toast(event.message, 'error');
        break;
    }
  }

  /** Events from the iOS plugin. */
  private onNativeEvent(event: NativeWatchEvent) {
    switch (event.kind) {
      case 'received':
        this.addLog(`received “${event.name}” via ${event.via}${event.sender ? ` from ${event.sender}` : ''}`);
        void this.importInbox();
        break;
      case 'paired':
        // Rust records it and answers with its own `paired` event.
        void this.client
          .recordPairing(event.watchName, event.via)
          .then((status) => (this.status = status))
          .catch((error) => this.addLog(`could not record pairing: ${errorMessage(error)}`));
        break;
      case 'bluetooth':
        if (this.native) this.native = { ...this.native, bluetooth: event.state };
        this.addLog(`Bluetooth: ${event.state}`);
        break;
      case 'log':
        this.addLog(event.message);
        break;
    }
  }

  // ------------------------------------------------------------ helpers

  /** (Re)start the iOS receivers with the current identity. */
  private async syncNative() {
    const status = this.status;
    if (!this.nativeAvailable || !status) return;
    try {
      this.native = await this.client.startNative(
        {
          inboxDir: status.inboxDir,
          displayName: status.displayName,
          deviceId: status.deviceId,
          secret: status.secret,
          bluetooth: status.enabled,
        },
        (event) => this.onNativeEvent(event),
      );
    } catch (error) {
      this.addLog(`native receiver: ${errorMessage(error)}`);
    }
  }

  private added(sketches: Sketch[]) {
    if (sketches.length === 0) return;
    this.hooks.onSketches(sketches);
    this.hooks.toast(
      sketches.length === 1
        ? 'A recording from your Apple Watch was added.'
        : `${sketches.length} recordings from your Apple Watch were added.`,
    );
  }

  private addLog(message: string) {
    const d = new Date();
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    this.log = [...this.log.slice(-199), `${time} [watch] ${message}`];
  }
}
