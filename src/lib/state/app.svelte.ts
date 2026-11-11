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
import { getLibrary, type Sketch } from '../library';
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
  startedAt: number;
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

class AppState {
  readonly library = getLibrary();
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

  private captureEngine: CaptureEngine | null = null;
  private active: ActiveRecording | null = null;
  private toastId = 0;

  readonly queue = new ProcessingQueue({
    library: this.library,
    capture: () => this.captureEngine,
    engine: () => getTranscriptionEngine(this.settings.sensitivity),
    onProgress: (id, progress) => {
      if (progress) this.jobs[id] = progress;
      else delete this.jobs[id];
    },
    onSketchChanged: (sketch) => this.upsert(sketch),
  });

  get canRecord(): boolean {
    return this.captureEngine !== null;
  }

  async init() {
    if (this.ready) return;
    try {
      this.capabilities = await detectCapabilities();
      this.captureEngine = createCaptureEngine(this.capabilities);
      if (!isIOSLike() && !this.capabilities.nativeCapture && !localStorage.getItem(SETTINGS_KEY)) {
        // Desktop webcams face the player.
        this.settings.camera = 'front';
      }
      const report = await this.library.recover();
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
    this.queue.cancel(id);
    await this.library.remove(id);
    this.sketches = this.sketches.filter((s) => s.id !== id);
    if (this.view.name === 'sketch' && this.view.id === id) this.goHome();
    this.toast('Sketch deleted.');
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

  // --------------------------------------------------------------- capture

  /** One tap: permissions (first time only), reserve a sketch, record. */
  async startRecording() {
    const engine = this.captureEngine;
    if (this.recording) return;
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
    this.recording = {
      phase: 'starting',
      sketchId: null,
      startedAt: performance.now(),
      elapsedMs: 0,
      levelDb: -160,
      peakDb: -160,
      hasVideo: wantsVideo,
      nativePreview: engine.nativePreview && wantsVideo,
      warning: null,
    };
    this.queue.setPaused(true);

    let sketchId: string | null = null;
    try {
      let permissions = await engine.checkPermissions(settings);
      if (permissions.microphone === 'prompt' || (wantsVideo && permissions.camera === 'prompt')) {
        permissions = await engine.requestPermissions(settings);
      }
      const micDenied = permissions.microphone === 'denied';
      const camDenied = wantsVideo && permissions.camera === 'denied';
      if (micDenied || camDenied) {
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
      if (this.recording.nativePreview) document.documentElement.classList.add('native-preview');

      const id = created.id;
      this.active = await engine.start(
        { ...created, writeChunk: async (bytes) => void (await this.library.writeFile(id, 'media-chunk', bytes)) },
        settings,
        (event) => this.onCaptureEvent(event),
      );
      if (this.recording) {
        this.recording = {
          ...this.recording,
          phase: 'recording',
          sketchId: id,
          startedAt: performance.now(),
          hasVideo: this.active.hasVideo,
          previewStream: this.active.previewStream,
        };
      }
    } catch (error) {
      document.documentElement.classList.remove('native-preview');
      if (sketchId) await this.library.discard(sketchId).catch(() => {});
      this.endRecordingUi();
      const code = errorCode(error);
      const name = error instanceof DOMException ? error.name : '';
      if (code === 'permission_denied' || name === 'NotAllowedError') {
        this.permissionProblem = { microphone: true, camera: wantsVideo, canOpenSettings: !!engine.openSettings };
      } else {
        this.toast(`Could not start recording: ${errorMessage(error)}`, 'error');
      }
    }
  }

  async stopRecording() {
    const recording = this.recording;
    const active = this.active;
    if (!recording || recording.phase !== 'recording' || !active) return;
    this.recording = { ...recording, phase: 'saving' };
    let result: RecordingResult;
    try {
      result = await active.stop();
    } catch (error) {
      // The file on disk is still the source of truth; try to save it.
      result = {
        ok: false,
        durationMs: performance.now() - recording.startedAt,
        hasVideo: recording.hasVideo,
        message: errorMessage(error),
      };
    }
    await this.finishRecording(result);
  }

  openPermissionSettings() {
    void this.captureEngine?.openSettings?.();
    this.permissionProblem = null;
  }

  private onCaptureEvent(event: CaptureEvent) {
    const recording = this.recording;
    if (!recording) return;
    switch (event.type) {
      case 'level':
        recording.levelDb = event.averageDb;
        recording.peakDb = event.peakDb;
        recording.elapsedMs = event.elapsedMs;
        break;
      case 'interrupted':
        recording.warning = 'Recording was interrupted.';
        break;
      case 'error':
        recording.warning = event.message;
        break;
      case 'finished':
        // Ended without a stop request (call, app backgrounded, disk full).
        if (recording.phase === 'recording') {
          this.recording = { ...recording, phase: 'saving' };
          void this.finishRecording(event);
        }
        break;
    }
  }

  private async finishRecording(result: RecordingResult) {
    const id = this.recording?.sketchId;
    this.active = null;
    document.documentElement.classList.remove('native-preview');
    if (!id) {
      this.endRecordingUi();
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
      this.upsert(sketch);
      this.toast(result.ok ? 'Sketch saved.' : 'Recording was interrupted, but the take was saved.', 'info', {
        label: 'Open',
        run: () => this.openSketch(id),
      });
      if (this.settings.autoTranscribe) this.queue.enqueue(id);
    } catch (error) {
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
