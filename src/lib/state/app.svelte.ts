/**
 * Application state and the capture flow. Components read this reactive
 * object and call its methods; engines and storage stay behind interfaces.
 */
import {
  createCaptureEngine,
  detectCapabilities,
  type ActiveRecording,
  type CaptureEngine,
  type CaptureEvent,
  type CaptureSettings,
  type PlatformCapabilities,
  type RecordingResult,
} from '../capture';
import { getLibrary, type Sketch, type SketchLibrary } from '../library';
import { ProcessingQueue, type JobProgress } from '../pipeline/processingQueue';
import { errorCode, errorMessage, isIOSLike } from '../platform/tauri';
import { getTranscriptionEngine, type Sensitivity } from '../transcription';

export interface Settings extends CaptureSettings {
  sensitivity: Sensitivity;
  autoTranscribe: boolean;
}

export type View = { name: 'home' } | { name: 'sketch'; id: string };

export interface RecordingState {
  phase: 'starting' | 'recording' | 'saving';
  sketchId: string | null;
  /** Increments with every start attempt; events from older attempts are ignored. */
  attempt: number;
  /** This attempt is the automatic retry of a failed one. */
  retry: boolean;
  startedAt: number;
  /** When the stop button becomes active (guards against a double tap). */
  armedAt: number;
  elapsedMs: number;
  levelDb: number;
  peakDb: number;
  hasVideo: boolean;
  nativePreview: boolean;
  previewStream?: MediaStream;
  warning: string | null;
}

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export interface PermissionProblem {
  camera: boolean;
  microphone: boolean;
  canOpenSettings: boolean;
}

const SETTINGS_KEY = 'earbud.settings.v1';

/** A take that ends on its own sooner than this is treated as a failed start. */
export const EARLY_FAILURE_MS = 1500;
/** Stop taps this soon after recording begins are ignored (double-tap guard). */
export const STOP_GUARD_MS = 600;
/** Backstop if the capture engine never answers a start request. */
export const START_TIMEOUT_MS = 15_000;

export interface AppStateOptions {
  library?: SketchLibrary;
  /** Override capture backend selection (tests); `null` disables capture. */
  captureEngine?: CaptureEngine | null;
  capabilities?: PlatformCapabilities;
  startTimeoutMs?: number;
}

const DEFAULT_SETTINGS: Settings = {
  camera: 'back',
  lens: 'wide',
  rawAudio: false,
  sensitivity: 'balanced',
  autoTranscribe: true,
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // storage unavailable
  }
  return { ...DEFAULT_SETTINGS };
}

function viewFromHash(): View {
  const match = /^#\/sketch\/([0-9a-f]{32})$/.exec(location.hash);
  return match ? { name: 'sketch', id: match[1] } : { name: 'home' };
}

export class AppState {
  readonly library: SketchLibrary;
  capabilities = $state<PlatformCapabilities | null>(null);
  ready = $state(false);
  sketches = $state<Sketch[]>([]);
  view = $state<View>({ name: 'home' });
  settings = $state<Settings>(loadSettings());
  recording = $state<RecordingState | null>(null);
  jobs = $state<Record<string, JobProgress>>({});
  toasts = $state<Toast[]>([]);
  permissionProblem = $state<PermissionProblem | null>(null);
  /** Bumped whenever a sketch changes, so open views can reload. */
  revision = $state<Record<string, number>>({});
  /** Sketches the export sheet is open for (null when closed). */
  exportRequest = $state<string[] | null>(null);

  private captureEngine: CaptureEngine | null = null;
  private active: ActiveRecording | null = null;
  private toastId = 0;
  private attempt = 0;
  /** A `finished` event that arrived before the start request resolved. */
  private pendingFinish: RecordingResult | null = null;
  private captureLog: string[] = [];
  private readonly options: AppStateOptions;
  readonly queue: ProcessingQueue;

  constructor(options: AppStateOptions = {}) {
    this.options = options;
    this.library = options.library ?? getLibrary();
    this.queue = new ProcessingQueue({
      library: this.library,
      capture: () => this.captureEngine,
      engine: () => getTranscriptionEngine(this.settings.sensitivity),
      onProgress: (id, progress) => {
        if (progress) this.jobs[id] = progress;
        else delete this.jobs[id];
      },
      onSketchChanged: (sketch) => this.upsert(sketch),
    });
  }

  get canRecord(): boolean {
    return this.captureEngine !== null;
  }

  async init() {
    if (this.ready) return;
    try {
      this.capabilities = this.options.capabilities ?? (await detectCapabilities());
      this.captureEngine =
        this.options.captureEngine !== undefined
          ? this.options.captureEngine
          : createCaptureEngine(this.capabilities);
      if (!isIOSLike() && !this.capabilities.nativeCapture && !localStorage.getItem(SETTINGS_KEY)) {
        // Desktop webcams face the player.
        this.settings.camera = 'front';
      }
      const report = await this.library.recover();
      if (!this.library.persistent && new URLSearchParams(location.search).has('demo')) {
        const { seedDemo } = await import('../dev/demo');
        await seedDemo(this.library);
      }
      this.sketches = await this.library.list();
      if (report.recovered.length > 0) {
        this.toast(
          report.recovered.length === 1
            ? 'Recovered an interrupted recording.'
            : `Recovered ${report.recovered.length} interrupted recordings.`,
        );
      }
      if (this.settings.autoTranscribe) {
        for (const sketch of [...this.sketches].reverse()) {
          if (sketch.status === 'saved' && sketch.transcriptionStatus === 'pending') this.queue.enqueue(sketch.id);
        }
      }
    } catch (error) {
      this.toast(`Could not open the sketch library: ${errorMessage(error)}`, 'error');
    } finally {
      this.view = viewFromHash();
      window.addEventListener('popstate', () => (this.view = viewFromHash()));
      this.ready = true;
    }
  }

  // ------------------------------------------------------------- navigation

  openSketch(id: string) {
    history.pushState(null, '', `#/sketch/${id}`);
    this.view = { name: 'sketch', id };
  }

  goHome() {
    if (this.view.name !== 'home' && history.length > 1 && location.hash) history.back();
    else {
      history.replaceState(null, '', location.pathname);
      this.view = { name: 'home' };
    }
  }

  // ---------------------------------------------------------------- library

  upsert(sketch: Sketch) {
    const index = this.sketches.findIndex((s) => s.id === sketch.id);
    if (index >= 0) this.sketches[index] = sketch;
    else this.sketches = [sketch, ...this.sketches].sort((a, b) => b.createdAt - a.createdAt);
    this.revision[sketch.id] = (this.revision[sketch.id] ?? 0) + 1;
  }

  async refresh() {
    this.sketches = await this.library.list();
  }

  async rename(id: string, title: string) {
    this.upsert(await this.library.update({ id, title }));
  }

  async saveNotesText(id: string, textNotes: string) {
    this.upsert(await this.library.update({ id, textNotes }));
  }

  async deleteSketch(id: string) {
    await this.deleteSketches([id]);
  }

  async deleteSketches(ids: string[]) {
    for (const id of ids) {
      this.queue.cancel(id);
      await this.library.remove(id);
    }
    const gone = new Set(ids);
    this.sketches = this.sketches.filter((s) => !gone.has(s.id));
    if (this.view.name === 'sketch' && gone.has(this.view.id)) this.goHome();
    this.toast(ids.length === 1 ? 'Sketch deleted.' : `${ids.length} sketches deleted.`);
  }

  /** Open the export sheet for one or more sketches. */
  shareSketches(ids: string[]) {
    if (ids.length > 0) this.exportRequest = [...ids];
  }

  /** Dependencies for the exporter (storage + native capture helpers). */
  exportDeps() {
    return { library: this.library, capture: this.captureEngine };
  }

  transcribe(id: string) {
    this.queue.enqueue(id);
  }

  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      // storage unavailable: settings last for this session
    }
  }

  // ---------------------------------------------------------------- toasts

  toast(message: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
    const id = ++this.toastId;
    this.toasts = [...this.toasts, { id, message, kind, action }];
    window.setTimeout(() => this.dismissToast(id), kind === 'error' ? 7000 : 4000);
  }

  dismissToast(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  // ----------------------------------------------------------- diagnostics

  /** Append a line to the capture log shown in Settings → Diagnostics. */
  logCapture(message: string) {
    const d = new Date();
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    this.captureLog = [...this.captureLog.slice(-299), `${time} [app] ${message}`];
    console.info('[earbud]', message);
  }

  /** App and native capture logs merged in time order, as plain text. */
  async captureDiagnostics(): Promise<string> {
    const engine = this.captureEngine;
    const header = [
      `Earbud capture diagnostics, ${new Date().toString()}`,
      `backend: ${engine?.id ?? 'none'}; platform: ${this.capabilities?.platform ?? 'unknown'}`,
      `user agent: ${navigator.userAgent}`,
    ];
    let nativeLines: string[] = [];
    try {
      const native = await engine?.diagnostics?.();
      if (native) {
        header.push(`audio session: ${native.audioSession ?? 'n/a'}`);
        header.push(`permissions: camera=${native.camera ?? '?'} microphone=${native.microphone ?? '?'}`);
        nativeLines = native.lines.map((line) => line.replace(/^(\S+) /, '$1 [ios] '));
      }
    } catch (error) {
      header.push(`native log unavailable: ${errorMessage(error)}`);
    }
    // Both logs start with a local HH:MM:SS.mmm timestamp.
    const merged = [...this.captureLog, ...nativeLines].sort((a, b) => a.slice(0, 12).localeCompare(b.slice(0, 12)));
    return [...header, '', ...merged].join('\n');
  }

  // --------------------------------------------------------------- capture

  /**
   * One tap: permissions (first time only), reserve a sketch, record.
   * A start that fails, times out, or dies within the first moments is
   * retried once automatically before the user sees an error.
   */
  async startRecording(options: { retry?: boolean } = {}) {
    const engine = this.captureEngine;
    if (this.recording && !options.retry) return;
    if (!engine) {
      this.toast('Recording is not available on this device.', 'error');
      return;
    }
    const settings: CaptureSettings = {
      camera: this.settings.camera,
      lens: this.settings.lens,
      rawAudio: this.settings.rawAudio,
    };
    const wantsVideo = settings.camera !== 'none';
    const attempt = ++this.attempt;
    const retry = !!options.retry;
    this.pendingFinish = null;
    this.recording = {
      phase: 'starting',
      sketchId: null,
      attempt,
      retry,
      startedAt: performance.now(),
      armedAt: Infinity,
      elapsedMs: 0,
      levelDb: -160,
      peakDb: -160,
      hasVideo: wantsVideo,
      nativePreview: engine.nativePreview && wantsVideo,
      warning: retry ? 'Restarting the recording…' : null,
    };
    this.queue.setPaused(true);
    this.logCapture(`${retry ? 'automatic retry' : 'record tapped'} (attempt ${attempt}, ${engine.id}, camera=${settings.camera})`);

    let sketchId: string | null = null;
    try {
      let permissions = await engine.checkPermissions(settings);
      if (permissions.microphone === 'prompt' || (wantsVideo && permissions.camera === 'prompt')) {
        this.logCapture('asking for permissions');
        permissions = await engine.requestPermissions(settings);
      }
      const micDenied = permissions.microphone === 'denied';
      const camDenied = wantsVideo && permissions.camera === 'denied';
      if (micDenied || camDenied) {
        this.logCapture(`permission denied (microphone=${permissions.microphone}, camera=${permissions.camera})`);
        this.permissionProblem = { microphone: micDenied, camera: camDenied, canOpenSettings: !!engine.openSettings };
        this.endRecordingUi();
        return;
      }

      const format = engine.mediaFormat(settings);
      const created = await this.library.create({
        mediaExtension: format.extension,
        mediaMime: format.mime,
        captureBackend: engine.id,
      });
      sketchId = created.id;
      if (this.recording?.nativePreview) document.documentElement.classList.add('native-preview');

      const id = created.id;
      const requestedAt = performance.now();
      const active = await this.withStartTimeout(
        engine,
        engine.start(
          { ...created, writeChunk: async (bytes) => void (await this.library.writeFile(id, 'media-chunk', bytes)) },
          settings,
          (event) => this.onCaptureEvent(attempt, event),
        ),
      );
      if (attempt !== this.attempt || !this.recording) {
        // Superseded while starting: release the devices.
        void active.stop().catch(() => {});
        return;
      }
      this.active = active;
      const now = performance.now();
      this.logCapture(`recording started after ${Math.round(now - requestedAt)} ms`);
      this.recording = {
        ...this.recording,
        phase: 'recording',
        sketchId: id,
        startedAt: now,
        armedAt: now + STOP_GUARD_MS,
        hasVideo: active.hasVideo,
        previewStream: active.previewStream,
        warning: null,
      };
      const early = this.pendingFinish;
      if (early) {
        this.pendingFinish = null;
        this.recording = { ...this.recording, phase: 'saving' };
        await this.finishRecording(early, false);
      }
    } catch (error) {
      if (attempt !== this.attempt) return;
      document.documentElement.classList.remove('native-preview');
      if (sketchId) await this.library.discard(sketchId).catch(() => {});
      const code = errorCode(error);
      const name = error instanceof DOMException ? error.name : '';
      this.logCapture(`start failed (${code ?? (name || 'error')}): ${errorMessage(error)}`);
      if (code === 'permission_denied' || name === 'NotAllowedError') {
        this.permissionProblem = { microphone: true, camera: wantsVideo, canOpenSettings: !!engine.openSettings };
        this.endRecordingUi();
        return;
      }
      if (!retry) {
        await this.startRecording({ retry: true });
        return;
      }
      this.endRecordingUi();
      this.toast(`Could not start recording: ${errorMessage(error)} Details: Settings → Diagnostics.`, 'error');
    }
  }

  /** Reject the start if the engine never answers, and reset the engine. */
  private withStartTimeout(engine: CaptureEngine, start: Promise<ActiveRecording>): Promise<ActiveRecording> {
    const ms = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logCapture(`no answer from the capture engine after ${ms} ms; resetting it`);
        void engine.reset?.().catch(() => {});
        // A late success must not leave the camera running.
        start.then(
          (late) => void late.stop().catch(() => {}),
          () => {},
        );
        reject(Object.assign(new Error('The camera did not start in time.'), { code: 'start_timeout' }));
      }, ms);
      start.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async stopRecording() {
    const recording = this.recording;
    const active = this.active;
    if (!recording || recording.phase !== 'recording' || !active) return;
    if (performance.now() < recording.armedAt) {
      this.logCapture('ignored a stop tap right after recording started');
      return;
    }
    this.recording = { ...recording, phase: 'saving' };
    this.logCapture('stop tapped');
    let result: RecordingResult;
    try {
      result = await active.stop();
    } catch (error) {
      // The file on disk is still the source of truth; try to save it.
      this.logCapture(`stop failed: ${errorMessage(error)}`);
      result = {
        ok: false,
        durationMs: performance.now() - recording.startedAt,
        hasVideo: recording.hasVideo,
        message: errorMessage(error),
      };
    }
    await this.finishRecording(result, true);
  }

  openPermissionSettings() {
    void this.captureEngine?.openSettings?.();
    this.permissionProblem = null;
  }

  private onCaptureEvent(attempt: number, event: CaptureEvent) {
    if (event.type === 'log') return; // native lines are read from the native log
    if (attempt !== this.attempt) {
      this.logCapture(`ignored a late '${event.type}' event from attempt ${attempt}`);
      return;
    }
    const recording = this.recording;
    if (!recording) return;
    switch (event.type) {
      case 'level':
        recording.levelDb = event.averageDb;
        recording.peakDb = event.peakDb;
        recording.elapsedMs = event.elapsedMs;
        break;
      case 'interrupted':
        this.logCapture(`interrupted: ${event.reason}`);
        recording.warning = `Interrupted: ${event.reason}`;
        break;
      case 'error':
        this.logCapture(`capture error: ${event.message}`);
        recording.warning = event.message;
        break;
      case 'finished': {
        const reason = event.interruption ?? event.message;
        this.logCapture(
          `capture ended without a stop request after ${Math.round(event.durationMs)} ms${reason ? ` (${reason})` : ''}`,
        );
        if (recording.phase === 'starting') {
          // Arrived before the start request resolved; handle it right after.
          this.pendingFinish = event;
        } else if (recording.phase === 'recording') {
          this.recording = { ...recording, phase: 'saving' };
          void this.finishRecording(event, false);
        }
        break;
      }
    }
  }

  private async finishRecording(result: RecordingResult, userStopped: boolean) {
    const recording = this.recording;
    const id = recording?.sketchId;
    this.active = null;
    document.documentElement.classList.remove('native-preview');
    if (!id) {
      this.endRecordingUi();
      return;
    }

    if (!userStopped && result.durationMs < EARLY_FAILURE_MS) {
      // Not a take: the recorder died as it started. Discard and retry.
      const reason = result.interruption ?? result.message;
      this.logCapture(`discarding a ${Math.round(result.durationMs)} ms take that ended on its own`);
      await this.library.discard(id).catch(() => {});
      if (!recording?.retry) {
        await this.startRecording({ retry: true });
        return;
      }
      this.endRecordingUi();
      this.toast(
        `Recording stopped as soon as it started${reason ? ` (${reason})` : ''}. Details: Settings → Diagnostics.`,
        'error',
      );
      return;
    }

    try {
      const sketch = await this.library.finalize({
        id,
        durationMs: Math.round(result.durationMs) || null,
        hasVideo: result.hasVideo,
        videoWidth: result.width ?? null,
        videoHeight: result.height ?? null,
      });
      this.logCapture(`saved ${Math.round(result.durationMs)} ms take${userStopped ? '' : ' (ended on its own)'}`);
      this.upsert(sketch);
      this.toast(
        userStopped || result.ok ? 'Sketch saved.' : 'Recording was interrupted, but the take was saved.',
        'info',
        { label: 'Open', run: () => this.openSketch(id) },
      );
      if (this.settings.autoTranscribe) this.queue.enqueue(id);
    } catch (error) {
      this.logCapture(`could not save the take: ${errorMessage(error)}`);
      await this.library.discard(id).catch(() => {});
      this.toast(`Nothing was recorded: ${errorMessage(error)}`, 'error');
    } finally {
      this.endRecordingUi();
      void this.refresh();
    }
  }

  private endRecordingUi() {
    this.recording = null;
    this.queue.setPaused(false);
  }
}

export const app = new AppState();
