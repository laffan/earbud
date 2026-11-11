// @vitest-environment happy-dom
/**
 * Capture-flow tests with a scriptable fake engine. They reproduce the
 * failure modes seen on iOS (a recording that ends as soon as it starts,
 * a start that never answers, events arriving out of order) and check that
 * one tap still produces exactly one good sketch, or a clear error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ActiveRecording,
  CaptureEngine,
  CaptureEvent,
  CapturePermissions,
  RecordingResult,
  RecordingTarget,
} from '../capture/types';
import { MemoryLibrary } from '../library/memoryLibrary';
import { AppState, STOP_GUARD_MS } from './app.svelte';

type Behaviour =
  | 'ok'
  | 'dies-after-start' // start resolves, then the recorder ends by itself
  | 'dies-before-start-resolves' // the 'finished' event beats the start reply
  | 'hangs' // start never answers
  | 'rejects';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const granted: CapturePermissions = { camera: 'granted', microphone: 'granted' };

class FakeEngine implements CaptureEngine {
  readonly id = 'fake';
  readonly nativePreview = true;
  starts = 0;
  resets = 0;
  stops = 0;
  emitters: ((e: CaptureEvent) => void)[] = [];
  constructor(public behaviours: Behaviour[]) {}

  mediaFormat() {
    return { extension: 'mov', mime: 'video/quicktime' };
  }
  async checkPermissions() {
    return granted;
  }
  async requestPermissions() {
    return granted;
  }
  async reset() {
    this.resets++;
  }

  async start(target: RecordingTarget, _s: unknown, onEvent: (e: CaptureEvent) => void): Promise<ActiveRecording> {
    const behaviour = this.behaviours[this.starts++] ?? 'ok';
    this.emitters.push(onEvent);
    const finished = (durationMs: number): CaptureEvent => ({
      type: 'finished',
      ok: true,
      durationMs,
      hasVideo: true,
      interruption: 'the microphone was taken by another audio session',
    });
    const recording: ActiveRecording = {
      hasVideo: true,
      stop: async (): Promise<RecordingResult> => {
        this.stops++;
        return { ok: true, durationMs: 4000, hasVideo: true, width: 1280, height: 720 };
      },
    };
    switch (behaviour) {
      case 'hangs':
        return new Promise(() => {});
      case 'rejects':
        throw Object.assign(new Error('Recording could not start: boom.'), { code: 'start_failed' });
      case 'dies-before-start-resolves':
        await target.writeChunk(new Uint8Array([1]));
        onEvent(finished(150));
        return recording;
      case 'dies-after-start':
        await target.writeChunk(new Uint8Array([1]));
        setTimeout(() => onEvent(finished(300)), 5);
        return recording;
      default:
        await target.writeChunk(new Uint8Array([1, 2, 3]));
        return recording;
    }
  }
}

function makeApp(engine: FakeEngine) {
  const library = new MemoryLibrary();
  const app = new AppState({
    library,
    captureEngine: engine,
    capabilities: { tauri: false, nativeCapture: true, nativeAudioExtraction: false, nativeShare: false, platform: 'test' },
    startTimeoutMs: 60,
  });
  app.updateSettings({ autoTranscribe: false });
  return { app, library };
}

async function until(predicate: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

async function recordAndStop(app: AppState) {
  await app.startRecording();
  await until(() => app.recording?.phase === 'recording');
  await sleep(STOP_GUARD_MS + 20);
  await app.stopRecording();
}

beforeEach(() => localStorage.clear());
afterEach(() => document.documentElement.classList.remove('native-preview'));

describe('capture flow', () => {
  it('records and saves one sketch', async () => {
    const engine = new FakeEngine(['ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await recordAndStop(app);
    const sketches = await library.list();
    expect(sketches).toHaveLength(1);
    expect(sketches[0].status).toBe('saved');
    expect(sketches[0].durationMs).toBe(4000);
    expect(app.recording).toBeNull();
    expect(app.toasts.map((t) => t.message)).toContain('Sketch saved.');
  });

  it('retries once when the recorder ends right after starting', async () => {
    const engine = new FakeEngine(['dies-after-start', 'ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => engine.starts === 2 && app.recording?.phase === 'recording');
    expect(app.recording?.retry).toBe(true);
    await sleep(STOP_GUARD_MS + 20);
    await app.stopRecording();
    const sketches = await library.list();
    expect(sketches).toHaveLength(1); // the 300 ms stub was discarded
    expect(sketches[0].durationMs).toBe(4000);
    expect(app.toasts.some((t) => t.kind === 'error')).toBe(false);
  });

  it('handles a finished event that arrives before the start reply', async () => {
    const engine = new FakeEngine(['dies-before-start-resolves', 'ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => engine.starts === 2 && app.recording?.phase === 'recording');
    await sleep(STOP_GUARD_MS + 20);
    await app.stopRecording();
    expect(await library.list()).toHaveLength(1);
  });

  it('resets the engine and retries when a start never answers', async () => {
    const engine = new FakeEngine(['hangs', 'ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => app.recording?.phase === 'recording');
    expect(engine.resets).toBe(1);
    await sleep(STOP_GUARD_MS + 20);
    await app.stopRecording();
    expect(await library.list()).toHaveLength(1);
  });

  it('retries a rejected start once', async () => {
    const engine = new FakeEngine(['rejects', 'ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await recordAndStop(app);
    expect(engine.starts).toBe(2);
    expect(await library.list()).toHaveLength(1);
  });

  it('gives a clear error and leaves no junk when both attempts fail', async () => {
    const engine = new FakeEngine(['dies-after-start', 'dies-after-start']);
    const { app, library } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => app.recording === null);
    expect(engine.starts).toBe(2);
    expect(await library.list()).toHaveLength(0);
    const error = app.toasts.find((t) => t.kind === 'error');
    expect(error?.message).toMatch(/stopped as soon as it started.*microphone was taken/);
    expect(document.documentElement.classList.contains('native-preview')).toBe(false);
    const log = await app.captureDiagnostics();
    expect(log).toMatch(/automatic retry/);
    expect(log).toMatch(/discarding a 300 ms take/);
  });

  it('ignores a stop tap in the first moments of a recording', async () => {
    const engine = new FakeEngine(['ok']);
    const { app } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => app.recording?.phase === 'recording');
    await app.stopRecording(); // the same finger landing on Stop
    expect(engine.stops).toBe(0);
    expect(app.recording?.phase).toBe('recording');
    await sleep(STOP_GUARD_MS + 20);
    await app.stopRecording();
    expect(engine.stops).toBe(1);
  });

  it('ignores late events from an abandoned attempt', async () => {
    const engine = new FakeEngine(['dies-after-start', 'ok']);
    const { app, library } = makeApp(engine);
    await app.init();
    await app.startRecording();
    await until(() => engine.starts === 2 && app.recording?.phase === 'recording');
    // A stray 'finished' from the first attempt must not end the second.
    engine.emitters[0]({ type: 'finished', ok: true, durationMs: 100, hasVideo: true });
    await sleep(20);
    expect(app.recording?.phase).toBe('recording');
    await sleep(STOP_GUARD_MS);
    await app.stopRecording();
    expect(await library.list()).toHaveLength(1);
  });
});
