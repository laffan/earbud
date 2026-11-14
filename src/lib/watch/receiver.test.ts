// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { Sketch } from '../library/types';
import { MemoryLibrary } from '../library/memoryLibrary';
import { AppState } from '../state/app.svelte';
import { WatchReceiver } from './receiver.svelte';
import type {
  ImportReport,
  NativeStartArgs,
  NativeWatchEvent,
  NativeWatchStatus,
  WatchLinkClient,
  WatchLinkEvent,
  WatchLinkStatus,
} from './types';

const tick = () => new Promise((r) => setTimeout(r, 0));

function sketch(id: string, createdAt: number): Sketch {
  return {
    id,
    title: '',
    createdAt,
    updatedAt: createdAt,
    status: 'saved',
    durationMs: 12_500,
    mediaPath: `/library/sketches/${id}/recording.m4a`,
    mediaMime: 'audio/mp4',
    hasVideo: false,
    videoWidth: null,
    videoHeight: null,
    analysisPath: null,
    textNotes: '',
    transcriptionStatus: 'pending',
    transcriptionError: null,
    captureBackend: 'apple-watch',
    recovered: false,
    summary: null,
    hasEdits: false,
    cropStartMs: null,
    cropEndMs: null,
    parentId: null,
    trackId: null,
    offsetMs: 0,
    countInMs: null,
  };
}

class FakeClient implements WatchLinkClient {
  calls: string[] = [];
  starts: NativeStartArgs[] = [];
  nativePairing: { code: string; durationMs: number } | null = null;
  recorded: { watchName: string; via: string }[] = [];
  inbox: Sketch[] = [];
  native = true;
  model = 'iPhone';
  rustHandler: ((e: WatchLinkEvent) => void) | null = null;
  nativeHandler: ((e: NativeWatchEvent) => void) | null = null;
  state: WatchLinkStatus = {
    enabled: false,
    listening: false,
    port: 50720,
    displayName: 'iPhone',
    nameIsDefault: true,
    deviceId: 'dev-1',
    secret: 'secret-1',
    addresses: ['192.168.1.20'],
    pairing: null,
    pairedWatches: [],
    error: null,
    inboxDir: '/library/inbox',
  };

  private snapshot(): NativeWatchStatus {
    return {
      bluetooth: this.starts.at(-1)?.bluetooth ? 'poweredOn' : 'off',
      phoneSessionSupported: true,
      phoneSessionActivated: true,
      watchPaired: true,
      watchAppInstalled: false,
      deviceModel: this.model,
      inboxDir: this.state.inboxDir,
      pendingInInbox: this.inbox.length,
    };
  }
  private done(name: string) {
    this.calls.push(name);
    return Promise.resolve({ ...this.state });
  }

  status() {
    return this.done('status');
  }
  setEnabled(enabled: boolean) {
    this.state.enabled = enabled;
    this.state.listening = enabled;
    return this.done(`setEnabled:${enabled}`);
  }
  setName(name: string) {
    this.state.displayName = name;
    this.state.nameIsDefault = false;
    return this.done(`setName:${name}`);
  }
  beginPairing() {
    this.state.enabled = true;
    this.state.pairing = { code: '04217', expiresAt: Date.now() + 120_000 };
    return this.done('beginPairing');
  }
  endPairing() {
    this.state.pairing = null;
    return this.done('endPairing');
  }
  recordPairing(watchName: string, via: string) {
    this.recorded.push({ watchName, via });
    this.state.pairing = null;
    this.state.pairedWatches = [{ name: watchName, via, pairedAt: 1 }];
    // Rust answers with its own event.
    setTimeout(() => this.rustHandler?.({ kind: 'paired', watchName, via }), 0);
    return this.done('recordPairing');
  }
  reset() {
    this.state.secret = 'secret-2';
    return this.done('reset');
  }
  resume() {
    return this.done('resume');
  }
  importInbox(): Promise<ImportReport> {
    this.calls.push('importInbox');
    const imported = this.inbox;
    this.inbox = [];
    return Promise.resolve({ imported, duplicates: 0, failed: [] });
  }
  async listen(handler: (e: WatchLinkEvent) => void) {
    this.rustHandler = handler;
    return () => (this.rustHandler = null);
  }
  async nativeAvailable() {
    return this.native;
  }
  async startNative(args: NativeStartArgs, onEvent: (e: NativeWatchEvent) => void) {
    this.starts.push(args);
    this.nativeHandler = onEvent;
    return this.snapshot();
  }
  async stopNative() {
    return this.snapshot();
  }
  async nativeBeginPairing(code: string, durationMs: number) {
    this.nativePairing = { code, durationMs };
    return this.snapshot();
  }
  async nativeEndPairing() {
    this.calls.push('nativeEndPairing');
    this.nativePairing = null;
    return this.snapshot();
  }
  async nativeStatus() {
    return this.snapshot();
  }
}

function makeReceiver(client: FakeClient) {
  const added: Sketch[][] = [];
  const toasts: string[] = [];
  const receiver = new WatchReceiver(client, {
    onSketches: (s) => added.push(s),
    toast: (m) => toasts.push(m),
  });
  return { receiver, added, toasts };
}

describe('WatchReceiver', () => {
  it('starts the native receivers with the identity from Rust and imports the inbox', async () => {
    const client = new FakeClient();
    client.inbox = [sketch('a'.repeat(32), 1)];
    const { receiver, added } = makeReceiver(client);
    await receiver.init();

    expect(client.starts).toHaveLength(1);
    expect(client.starts[0]).toEqual({
      inboxDir: '/library/inbox',
      displayName: 'iPhone',
      deviceId: 'dev-1',
      secret: 'secret-1',
      bluetooth: false, // receiving is off until the user turns it on
    });
    expect(added[0].map((s) => s.id)).toEqual(['a'.repeat(32)]);
    expect(receiver.native?.deviceModel).toBe('iPhone');
  });

  it('names an iPad "iPad" by default', async () => {
    const client = new FakeClient();
    client.model = 'iPad';
    const { receiver } = makeReceiver(client);
    await receiver.init();
    expect(receiver.status?.displayName).toBe('iPad');
    expect(client.starts.at(-1)?.displayName).toBe('iPad');
  });

  it('opens the pairing window on both receivers', async () => {
    const client = new FakeClient();
    const { receiver } = makeReceiver(client);
    await receiver.init();
    await receiver.beginPairing();

    expect(receiver.status?.pairing?.code).toBe('04217');
    // Receiving was switched on, so Bluetooth now advertises with the same identity.
    expect(client.starts.at(-1)?.bluetooth).toBe(true);
    expect(client.nativePairing?.code).toBe('04217');
    expect(client.nativePairing!.durationMs).toBeGreaterThan(119_000);

    await receiver.endPairing();
    expect(client.nativePairing).toBeNull();
    expect(receiver.status?.pairing).toBeNull();
  });

  it('records a Bluetooth pairing in Rust, then reports it once', async () => {
    const client = new FakeClient();
    const { receiver, toasts } = makeReceiver(client);
    await receiver.init();
    await receiver.beginPairing();

    client.nativeHandler!({ kind: 'paired', watchName: 'Studio Watch', via: 'bluetooth' });
    await tick();
    await tick();
    expect(client.recorded).toEqual([{ watchName: 'Studio Watch', via: 'bluetooth' }]);
    expect(toasts).toEqual(['Paired with Studio Watch.']);
    expect(client.calls).toContain('nativeEndPairing');
    expect(receiver.status?.pairedWatches.map((w) => w.name)).toEqual(['Studio Watch']);
  });

  it('imports when the plugin reports a recording, and adds what Rust imported', async () => {
    const client = new FakeClient();
    const { receiver, added, toasts } = makeReceiver(client);
    await receiver.init();

    client.inbox = [sketch('b'.repeat(32), 2)];
    client.nativeHandler!({ kind: 'received', name: 'Nov 11', sender: 'Watch', via: 'bluetooth' });
    await tick();
    expect(added.at(-1)?.map((s) => s.id)).toEqual(['b'.repeat(32)]);

    client.rustHandler!({ kind: 'imported', sketches: [sketch('c'.repeat(32), 3), sketch('d'.repeat(32), 4)] });
    expect(added.at(-1)).toHaveLength(2);
    expect(toasts.at(-1)).toBe('2 recordings from your Apple Watch were added.');
  });

  it('restarts the native receivers when the identity changes', async () => {
    const client = new FakeClient();
    const { receiver } = makeReceiver(client);
    await receiver.init();
    await receiver.rename('Studio iPhone');
    expect(client.starts.at(-1)?.displayName).toBe('Studio iPhone');
    await receiver.reset();
    expect(client.starts.at(-1)?.secret).toBe('secret-2');
  });

  it('works without the native plugin (desktop)', async () => {
    const client = new FakeClient();
    client.native = false;
    const { receiver } = makeReceiver(client);
    await receiver.init();
    await receiver.beginPairing();
    expect(client.starts).toHaveLength(0);
    expect(client.nativePairing).toBeNull();
    expect(receiver.status?.pairing?.code).toBe('04217');
  });
});

describe('AppState with the watch link', () => {
  it('lists recordings from the Watch and queues them for transcription', async () => {
    const client = new FakeClient();
    const library = new MemoryLibrary();
    const app = new AppState({
      library,
      captureEngine: null,
      watchLink: client,
      capabilities: {
        tauri: true,
        nativeCapture: false,
        nativeAudioExtraction: false,
        nativeShare: false,
        nativeAudioExport: false,
        platform: 'test',
      },
    });
    app.updateSettings({ autoTranscribe: false });
    await app.init();
    await tick();
    expect(app.watch).not.toBeNull();

    app.addReceived([sketch('e'.repeat(32), 10), sketch('f'.repeat(32), 5)]);
    expect(app.sketches.map((s) => s.id)).toEqual(['e'.repeat(32), 'f'.repeat(32)]);
  });
});
