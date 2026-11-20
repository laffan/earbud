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
import { Metronome } from '../capture/countIn';
import { setDeviceLog, setOutputDevice, type IosInput, type IosOutput } from '../audio/devices';
import { beginCaptureSession, webAudioSessionSummary } from '../audio/session';
import { CHORD_TAPS_BACKEND, CHORD_TAPS_ENGINE, importAudioSketch, importMidiSketch, notesSketch, type Placement } from '../library/importTrack';
import { getLibrary, type Sketch, type SketchLibrary } from '../library';
import type { CreateRhythmArgs, CreateSampleArgs, CreateTextNoteArgs, ListenMode, Notebook, Sample, UpdateRhythmArgs, UpdateTextNoteArgs } from '../library/types';
import { forgetSample, pitchedSample, renderedSample } from '../samples/render';
import type { RhythmPattern } from '../music/rhythm';
import type { PianoNote } from '../transcription/types';
import type { Crop } from '../ui/slice';
import { ProcessingQueue, type JobProgress } from '../pipeline/processingQueue';
import { errorCode, errorMessage, isIOSLike } from '../platform/tauri';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  getTranscriptionEngine,
  normalizeTranscriptionSettings,
  type TranscriptionSettings,
  type TranscriptionModel,
} from '../transcription';
import { WatchReceiver } from '../watch/receiver.svelte';
import { TauriWatchLink } from '../watch/tauriWatchLink';
import type { WatchLinkClient } from '../watch/types';

export interface Settings extends CaptureSettings {
  /** Recording environment and held-note handling used for new transcriptions. */
  transcription: TranscriptionSettings;
  autoTranscribe: boolean;
  /** Count in (COUNT_IN_BEATS beats) before every take. */
  countIn: boolean;
  /** Tempo of the count-in, in beats per minute. */
  countInBpm: number;
  /** Browser / desktop: the microphone's and the output's device ids ('' = the system's). */
  audioInput: string;
  audioOutput: string;
  /** iOS: the kind of microphone, and where sound plays while recording. */
  iosInput: IosInput;
  iosOutput: IosOutput;
}

/** Beats of the count-in. */
export const COUNT_IN_BEATS = 3;

/**
 * Recording a take into an open sketch: a new track, or a new take of a
 * track. The sketch view starts the other tracks at the downbeat.
 */
export interface TakeTarget {
  sketchId: string;
  /** The track to record a new take for; null adds a track. */
  trackId: string | null;
  /** Shown while recording, e.g. "Track 2". */
  label: string;
  /**
   * The sketch's tempo and one of its beats (seconds of sketch time): the
   * count-in runs at this tempo, and a dot flashes on its beats while recording.
   */
  tempo?: { bpm: number; beat: number };
  /**
   * The downbeat: start playing the other tracks and return where on the
   * sketch's timeline they started (seconds). The take is placed so that
   * its downbeat lines up with that point.
   */
  onDownbeat?: () => number;
  /** The take was saved, discarded or failed; stop playback. */
  onEnd?: (saved: Sketch | null) => void;
}

/**
 * Recording a new sketch onto a notebook's canvas, where it was pressed. The
 * canvas plays from there at the downbeat, so the new sketch can be played
 * over whatever is already on it.
 */
export interface CanvasTarget {
  notebookId: string;
  /** Where the take's downbeat goes on the notebook's timeline (seconds). */
  at: number;
  /** How far down the canvas it goes (canvas pixels). */
  y: number;
  /** A rhythm under the press: the count-in runs at its tempo. */
  tempo?: { bpm: number; beat: number };
  /** The downbeat: start playing the canvas and return the position heard now (seconds). */
  onDownbeat?: () => number;
  /** The take was saved, discarded or failed; stop playback. */
  onEnd?: (saved: Sketch | null) => void;
}

export type View = { name: 'home' } | { name: 'sketch'; id: string } | { name: 'reference' } | { name: 'samples' };

/** How a sketch is sliced in two (see `slice.ts`): crops of a recording, or a rhythm's two halves. */
export type SlicePlan =
  | { kind: 'audio'; first: Crop; second: Crop; secondTitle: string }
  | { kind: 'rhythm'; first: RhythmPattern; second: RhythmPattern; firstMs: number; secondMs: number; secondXMs: number; secondTitle: string };

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
  /** The count-in is running: the beat sounding now (1-based; 0 before the first). */
  countIn: { beat: number; beats: number } | null;
  /** Where the downbeat fell in the recording (ms), once it has. */
  downbeatMs: number | null;
  /** Where the other tracks started playing on the sketch's timeline (seconds). */
  playFrom: number | null;
  /** Recording a take into an open sketch (null: a new sketch). */
  take: { sketchId: string; trackId: string | null; label: string } | null;
  /** Recording a new sketch onto a notebook's canvas. */
  canvas: { notebookId: string; at: number; y: number } | null;
  /** The sketch's beat while recording a take into it: when one falls (performance.now ms) and how far apart. */
  pulse: { firstBeatAt: number; periodMs: number } | null;
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
/** The notebook last open. */
const NOTEBOOK_KEY = 'earbud.notebook.v1';

/** A take that ends on its own sooner than this is treated as a failed start. */
export const EARLY_FAILURE_MS = 1500;
/** Stop taps this soon after recording begins are ignored (double-tap guard). */
export const STOP_GUARD_MS = 600;
const RESTARTING = 'Restarting the recording…';
/** Backstop if the capture engine never answers a start request. */
export const START_TIMEOUT_MS = 15_000;

export interface AppStateOptions {
  library?: SketchLibrary;
  /** Override capture backend selection (tests); `null` disables capture. */
  captureEngine?: CaptureEngine | null;
  capabilities?: PlatformCapabilities;
  startTimeoutMs?: number;
  /** Override the Apple Watch link (tests); `null` disables it. */
  watchLink?: WatchLinkClient | null;
  /** Override the count-in clock and sound (tests). */
  metronome?: Metronome;
}

const DEFAULT_SETTINGS: Settings = {
  camera: 'back',
  lens: 'wide',
  rawAudio: false,
  transcription: DEFAULT_TRANSCRIPTION_SETTINGS,
  autoTranscribe: true,
  countIn: true,
  countInBpm: 90,
  audioInput: '',
  audioOutput: '',
  iosInput: 'auto',
  iosOutput: 'auto',
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      // `sensitivity` is the setting older versions stored instead of `transcription`.
      const { sensitivity, ...stored } = JSON.parse(raw) as Partial<Settings> & { sensitivity?: unknown };
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        transcription: normalizeTranscriptionSettings(stored.transcription, sensitivity),
      };
    }
  } catch {
    // storage unavailable
  }
  return { ...DEFAULT_SETTINGS };
}

function viewFromHash(): View {
  if (location.hash === '#/reference') return { name: 'reference' };
  if (location.hash === '#/samples') return { name: 'samples' };
  const match = /^#\/sketch\/([0-9a-f]{32})$/.exec(location.hash);
  return match ? { name: 'sketch', id: match[1] } : { name: 'home' };
}

export class AppState {
  readonly library: SketchLibrary;
  capabilities = $state<PlatformCapabilities | null>(null);
  ready = $state(false);
  /** Every sketch and take (takes of multi-track sketches have a `parentId`). */
  sketches = $state<Sketch[]>([]);
  /** The sketches shown in the list (not their takes). */
  readonly topLevel = $derived(this.sketches.filter((s) => s.parentId === null));
  /** Tracks per sketch, counted from the takes in `sketches`. */
  private readonly trackCounts = $derived.by(() => {
    const tracks = new Map<string, Set<string>>();
    for (const s of this.sketches) {
      const sketch = s.parentId ?? s.id;
      if (!tracks.has(sketch)) tracks.set(sketch, new Set());
      if (s.trackId) tracks.get(sketch)!.add(s.trackId);
    }
    return tracks;
  });

  /** How many tracks a sketch has (1 for a plain sketch). */
  trackCount(id: string): number {
    return Math.max(1, this.trackCounts.get(id)?.size ?? 1);
  }
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
  /** Receiving recordings from the Apple Watch app (null in the browser preview). */
  watch = $state<WatchReceiver | null>(null);
  /** Every notebook, oldest first. */
  notebooks = $state<Notebook[]>([]);
  /** The notebook whose canvas is shown. */
  notebookId = $state<string | null>(null);
  readonly notebook = $derived(this.notebooks.find((n) => n.id === this.notebookId) ?? null);
  /** The sample library, oldest first. */
  samples = $state<Sample[]>([]);
  /** A sketch copied for pasting (by id; pasting copies it again). */
  clipboard = $state<{ id: string } | null>(null);
  /** The sketches on the open notebook's canvas. */
  readonly canvasSketches = $derived(
    this.sketches.filter((s) => s.parentId === null && s.status === 'saved' && s.notebookId !== null && s.notebookId === this.notebookId),
  );

  private captureEngine: CaptureEngine | null = null;
  private active: ActiveRecording | null = null;
  private toastId = 0;
  private listenSaves = new Map<string, Promise<Sketch>>();
  private attempt = 0;
  /** A `finished` event that arrived before the start request resolved. */
  private pendingFinish: RecordingResult | null = null;
  /** The take being recorded into an open sketch (kept across the automatic retry). */
  private takeTarget: TakeTarget | null = null;
  /** The sketch being recorded onto a canvas (kept across the automatic retry). */
  private canvasTarget: CanvasTarget | null = null;
  private readonly metronome: Metronome;
  private releaseCaptureSession: (() => void) | null = null;
  private countInAbort: AbortController | null = null;
  /** Last level event: the recorder's own clock, to place the downbeat in the recording. */
  private lastLevel: { elapsedMs: number; at: number } | null = null;
  private captureLog: string[] = [];
  private readonly options: AppStateOptions;
  readonly queue: ProcessingQueue;

  constructor(options: AppStateOptions = {}) {
    this.options = options;
    this.library = options.library ?? getLibrary();
    this.metronome = options.metronome ?? new Metronome();
    setDeviceLog((message) => this.logCapture(`[audio] ${message}`));
    setOutputDevice(this.settings.audioOutput);
    this.queue = new ProcessingQueue({
      library: this.library,
      capture: () => this.captureEngine,
      engine: () => getTranscriptionEngine('basic-pitch', this.settings.transcription),
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
      const demo = new URLSearchParams(location.search).get('demo');
      if (!this.library.persistent && demo !== null) {
        const { seedDemoNotebook } = await import('../dev/demo');
        await seedDemoNotebook(this.library);
      }
      this.sketches = await this.library.list();
      await this.loadNotebooks();
      this.samples = await this.library.listSamples().catch((error) => {
        this.logCapture(`could not read the sample library: ${errorMessage(error)}`);
        return [];
      });
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
      this.startWatchLink();
    } catch (error) {
      this.toast(`Could not open the sketch library: ${errorMessage(error)}`, 'error');
    } finally {
      this.view = viewFromHash();
      window.addEventListener('popstate', () => (this.view = viewFromHash()));
      this.ready = true;
    }
  }

  // ----------------------------------------------------------- apple watch

  private startWatchLink() {
    const client =
      this.options.watchLink !== undefined
        ? this.options.watchLink
        : this.capabilities?.tauri
          ? new TauriWatchLink()
          : null;
    if (!client) return;
    const receiver = new WatchReceiver(client, {
      onSketches: (sketches) => this.addReceived(sketches),
      toast: (message, kind) => this.toast(message, kind),
    });
    this.watch = receiver;
    void receiver.init().catch((error) => this.logCapture(`watch link unavailable: ${errorMessage(error)}`));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void receiver.resume().catch(() => {});
    });
  }

  /** Sketches that arrived from the Watch: placed at the end of the open notebook, and transcribed, oldest first. */
  async addReceived(sketches: Sketch[]) {
    const oldestFirst = [...sketches].sort((a, b) => a.createdAt - b.createdAt);
    for (let sketch of oldestFirst) {
      if (sketch.notebookId === null && this.notebookId) {
        try {
          const at = this.canvasEnd() + 1;
          sketch = await this.library.placeSketch({ id: sketch.id, notebookId: this.notebookId, canvasXMs: Math.round(at * 1000), canvasY: 40 });
        } catch (error) {
          this.logCapture(`could not place a received recording: ${errorMessage(error)}`);
        }
      }
      this.upsert(sketch);
      if (this.settings.autoTranscribe && sketch.transcriptionStatus === 'pending') this.queue.enqueue(sketch.id);
    }
  }

  // -------------------------------------------------------------- notebooks

  private async loadNotebooks() {
    let notebooks = await this.library.listNotebooks();
    if (notebooks.length === 0) notebooks = [await this.library.createNotebook('Notebook 1')];
    this.notebooks = notebooks;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(NOTEBOOK_KEY);
    } catch {
      // storage unavailable
    }
    const open = notebooks.find((n) => n.id === stored) ?? notebooks[notebooks.length - 1];
    this.notebookId = open.id;
  }

  selectNotebook(id: string) {
    if (!this.notebooks.some((n) => n.id === id)) return;
    this.notebookId = id;
    try {
      localStorage.setItem(NOTEBOOK_KEY, id);
    } catch {
      // storage unavailable
    }
  }

  /** "Notebook 3": the first number not taken. */
  nextNotebookTitle(): string {
    const taken = new Set(this.notebooks.map((n) => n.title.trim()));
    let n = this.notebooks.length + 1;
    while (taken.has(`Notebook ${n}`)) n++;
    return `Notebook ${n}`;
  }

  async createNotebook(title = this.nextNotebookTitle()): Promise<Notebook | null> {
    try {
      const notebook = await this.library.createNotebook(title);
      this.notebooks = [...this.notebooks, notebook];
      this.selectNotebook(notebook.id);
      return notebook;
    } catch (error) {
      this.toast(`Could not create a notebook: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  private replaceNotebook(notebook: Notebook) {
    this.notebooks = this.notebooks.map((n) => (n.id === notebook.id ? notebook : n));
  }

  async renameNotebook(id: string, title: string) {
    try {
      this.replaceNotebook(await this.library.renameNotebook(id, title));
    } catch (error) {
      this.toast(`Could not rename the notebook: ${errorMessage(error)}`, 'error');
    }
  }

  /** Where repeat loops on the notebook (ms), or nulls for the extent of its sketches. */
  async setNotebookLoop(id: string, startMs: number | null, endMs: number | null) {
    const current = this.notebooks.find((n) => n.id === id);
    if (current) this.replaceNotebook({ ...current, loopStartMs: startMs, loopEndMs: endMs });
    try {
      this.replaceNotebook(await this.library.setNotebookLoop(id, startMs, endMs));
    } catch (error) {
      this.toast(`Could not save the loop: ${errorMessage(error)}`, 'error');
    }
  }

  /** Delete a notebook with every sketch on it; another one opens (a new one if it was the last). */
  async deleteNotebook(id: string) {
    const gone = new Set(this.sketches.filter((s) => s.notebookId === id && s.parentId === null).map((s) => s.id));
    for (const s of this.sketches) if (s.parentId && gone.has(s.parentId)) gone.add(s.id);
    for (const sketch of gone) this.queue.cancel(sketch);
    try {
      await this.library.removeNotebook(id);
    } catch (error) {
      this.toast(`Could not delete the notebook: ${errorMessage(error)}`, 'error');
      return;
    }
    this.sketches = this.sketches.filter((s) => !gone.has(s.id));
    this.notebooks = this.notebooks.filter((n) => n.id !== id);
    if (this.notebookId === id) {
      const next = this.notebooks[this.notebooks.length - 1];
      if (next) this.selectNotebook(next.id);
      else await this.createNotebook('Notebook 1');
    }
    this.toast('Notebook deleted.');
  }

  /** The end of the last sketch on the open canvas (seconds of its timeline). */
  canvasEnd(): number {
    let end = 0;
    for (const s of this.canvasSketches) end = Math.max(end, s.canvasXMs / 1000 + (s.durationMs ?? 0) / 1000);
    return end;
  }

  /** Move a sketch on its canvas. Shown at once; the library confirms. */
  async placeSketch(id: string, canvasXMs: number, canvasY: number) {
    const index = this.sketches.findIndex((s) => s.id === id);
    if (index >= 0) this.sketches[index] = { ...this.sketches[index], canvasXMs: Math.round(canvasXMs), canvasY };
    try {
      this.upsert(await this.library.placeSketch({ id, canvasXMs: Math.round(canvasXMs), canvasY }));
    } catch (error) {
      this.toast(`Could not move the sketch: ${errorMessage(error)}`, 'error');
      void this.refresh();
    }
  }

  /** How many times a recording plays in a row on its canvas. Shown at once; the library confirms. */
  async setRepeats(id: string, repeats: number) {
    const index = this.sketches.findIndex((s) => s.id === id);
    if (index >= 0) this.sketches[index] = { ...this.sketches[index], canvasRepeats: repeats };
    try {
      this.upsert(await this.library.setRepeats(id, repeats));
    } catch (error) {
      this.toast(`Could not change the repeats: ${errorMessage(error)}`, 'error');
      void this.refresh();
    }
  }

  /**
   * Slice a sketch into two that stand on their own: a copy becomes the
   * second half, the original keeps the first. A recording's halves play
   * complementary crops of the same (untouched) recording, once each; a
   * rhythm's halves play their own bars. Undone if a step fails.
   */
  async sliceSketch(id: string, plan: SlicePlan): Promise<boolean> {
    const source = this.sketches.find((s) => s.id === id);
    if (!source || source.notebookId === null) return false;
    let copyId: string | null = null;
    try {
      const copy = await this.library.duplicate({
        id,
        notebookId: source.notebookId,
        canvasXMs: Math.round(plan.kind === 'rhythm' ? plan.secondXMs : source.canvasXMs),
        canvasY: source.canvasY,
      });
      copyId = copy.id;
      await this.library.update({ id: copy.id, title: plan.secondTitle });
      let first: Sketch;
      let second: Sketch;
      if (plan.kind === 'rhythm') {
        second = await this.library.updateRhythm({ id: copy.id, rhythm: plan.second, durationMs: plan.secondMs });
        first = await this.library.updateRhythm({ id, rhythm: plan.first, durationMs: plan.firstMs });
      } else {
        await this.library.setCrop(copy.id, plan.second.startMs, plan.second.endMs);
        await this.library.setCrop(id, plan.first.startMs, plan.first.endMs);
        // The cut is in the part that repeats: each half plays once.
        if (source.canvasRepeats !== 1) {
          await this.library.setRepeats(copy.id, 1);
          await this.library.setRepeats(id, 1);
        }
        second = await this.sketchRow(copy.id);
        first = await this.sketchRow(id);
      }
      this.upsert(first);
      this.upsert(second);
      if (second.kind === 'audio' && second.transcriptionStatus === 'pending' && this.settings.autoTranscribe) this.queue.enqueue(second.id);
      return true;
    } catch (error) {
      if (copyId) await this.library.remove(copyId).catch(() => {});
      this.toast(`Could not slice the sketch: ${errorMessage(error)}`, 'error');
      void this.refresh();
      return false;
    }
  }

  /** A sketch's row as the list holds it (without its transcription and tracks). */
  private async sketchRow(id: string): Promise<Sketch> {
    const { transcription: _transcription, tracks: _tracks, ...sketch } = await this.library.get(id);
    return sketch;
  }

  private volumeSaves = new Map<string, number>();

  /**
   * How loud a sketch plays on its canvas (0–1). Heard at once (the slider
   * moves it continuously) and saved once it rests. The revision is not bumped
   * and the saved row is not taken back, so the canvas keeps its decoded sound.
   */
  setVolume(id: string, volume: number) {
    const v = Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
    const index = this.sketches.findIndex((s) => s.id === id);
    if (index < 0) return;
    this.sketches[index] = { ...this.sketches[index], canvasVolume: v };
    window.clearTimeout(this.volumeSaves.get(id));
    this.volumeSaves.set(
      id,
      window.setTimeout(() => {
        this.volumeSaves.delete(id);
        this.library.setVolume(id, v).catch((error) => {
          this.toast(`Could not change the volume: ${errorMessage(error)}`, 'error');
          void this.refresh();
        });
      }, 250),
    );
  }

  /** Copy a sketch for pasting onto a canvas (this notebook's or another's). */
  copySketch(id: string) {
    const sketch = this.sketches.find((s) => s.id === id);
    if (!sketch) return;
    this.clipboard = { id };
    this.toast('Copied. Press and hold the canvas to paste it.');
  }

  /** The copied sketch, while it still exists. */
  get copied(): Sketch | null {
    const clip = this.clipboard;
    return clip ? (this.sketches.find((s) => s.id === clip.id) ?? null) : null;
  }

  /**
   * A copy of a sketch on a canvas: its recording and notes (or its rhythm)
   * and settings. One still to be transcribed is queued.
   */
  async duplicateSketch(id: string, place: Placement): Promise<Sketch | null> {
    try {
      const copy = await this.library.duplicate({ id, ...place, canvasXMs: Math.round(place.canvasXMs) });
      this.upsert(copy);
      if (copy.kind === 'audio' && copy.transcriptionStatus === 'pending' && this.settings.autoTranscribe) this.queue.enqueue(copy.id);
      return copy;
    } catch (error) {
      this.toast(`Could not copy the sketch: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  async createTextNote(args: CreateTextNoteArgs): Promise<Sketch | null> {
    try {
      const note = await this.library.createTextNote(args);
      this.upsert(note);
      return note;
    } catch (error) {
      this.toast(`Could not save the note: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  /** Change a note's text or box. Shown at once; the library confirms. */
  async updateTextNote(args: UpdateTextNoteArgs): Promise<Sketch | null> {
    const index = this.sketches.findIndex((s) => s.id === args.id);
    if (index >= 0) {
      const s = this.sketches[index];
      this.sketches[index] = {
        ...s,
        textNotes: args.text ?? s.textNotes,
        canvasW: args.clearSize ? null : (args.canvasW ?? s.canvasW),
        canvasH: args.clearSize ? null : (args.canvasH ?? s.canvasH),
      };
    }
    try {
      const note = await this.library.updateTextNote(args);
      this.upsert(note);
      return note;
    } catch (error) {
      this.toast(`Could not save the note: ${errorMessage(error)}`, 'error');
      void this.refresh();
      return null;
    }
  }

  /** Remove a note without asking (it was emptied). */
  async removeTextNote(id: string) {
    try {
      await this.library.remove(id);
      this.sketches = this.sketches.filter((s) => s.id !== id);
    } catch (error) {
      this.toast(`Could not remove the note: ${errorMessage(error)}`, 'error');
    }
  }

  async createRhythm(args: CreateRhythmArgs): Promise<Sketch | null> {
    try {
      const sketch = await this.library.createRhythm(args);
      this.upsert(sketch);
      return sketch;
    } catch (error) {
      this.toast(`Could not save the rhythm: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  async updateRhythm(args: UpdateRhythmArgs): Promise<Sketch | null> {
    try {
      const sketch = await this.library.updateRhythm(args);
      this.upsert(sketch);
      return sketch;
    } catch (error) {
      this.toast(`Could not save the rhythm: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  /**
   * Import a MIDI or audio file as a new sketch on a canvas. Audio is
   * transcribed like a recording; MIDI brings its own notes. Returns whether
   * it worked (problems are toasted).
   */
  async importSketch(kind: 'midi' | 'audio', file: File, place: Placement): Promise<boolean> {
    try {
      const deps = { library: this.library };
      const result = kind === 'midi' ? await importMidiSketch(deps, file, place) : await importAudioSketch(deps, file, place);
      this.upsert(result.sketch);
      if (result.transcribe && this.settings.autoTranscribe) this.queue.enqueue(result.sketch.id);
      this.logCapture(`imported ${file.name} (${kind}, ${file.size} bytes)`);
      this.toast(`Imported “${result.sketch.title}”.`);
      return true;
    } catch (error) {
      this.toast(`Could not import ${file.name}: ${errorMessage(error)}`, 'error');
      return false;
    }
  }

  // --------------------------------------------------------- sample library

  /** The library's samples by id. */
  sample(id: string | null | undefined): Sample | null {
    return id ? (this.samples.find((s) => s.id === id) ?? null) : null;
  }

  /** A sample's sound with its settings, at a sample rate (null if it is gone): for rhythm pads. */
  readonly sampleSound = async (id: string, sampleRate: number): Promise<Float32Array | null> => {
    const sample = this.sample(id);
    return sample ? renderedSample(sample, sampleRate) : null;
  };

  /** Add a sound to the sample library (a mono WAV). Problems are toasted. */
  async addSample(args: CreateSampleArgs, wav: Uint8Array): Promise<Sample | null> {
    try {
      const sample = await this.library.createSample(args, wav);
      this.samples = [...this.samples, sample];
      this.toast(`Added “${sample.title || 'Sample'}” to the library.`, 'info', { label: 'Open', run: () => this.openSamples() });
      return sample;
    } catch (error) {
      this.toast(`Could not add the sample: ${errorMessage(error)}`, 'error');
      return null;
    }
  }

  /** Rename a sample or change its settings. Shown at once; the library confirms. */
  async updateSample(id: string, patch: { title?: string; settings?: Record<string, unknown> }): Promise<Sample | null> {
    const index = this.samples.findIndex((s) => s.id === id);
    if (index >= 0) {
      const current = this.samples[index];
      this.samples[index] = {
        ...current,
        title: patch.title?.trim() ?? current.title,
        settings: patch.settings ?? current.settings,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
    }
    try {
      const saved = await this.library.updateSample({ id, ...patch });
      const at = this.samples.findIndex((s) => s.id === id);
      if (at >= 0) this.samples[at] = saved;
      this.touchSampleUsers(id);
      return saved;
    } catch (error) {
      this.toast(`Could not save the sample: ${errorMessage(error)}`, 'error');
      this.samples = await this.library.listSamples().catch(() => this.samples);
      return null;
    }
  }

  /** Delete a sample. Sketches whose notes played with it go back to the piano; pads to their own sounds. */
  async deleteSample(id: string) {
    try {
      await this.library.removeSample(id);
    } catch (error) {
      this.toast(`Could not delete the sample: ${errorMessage(error)}`, 'error');
      return;
    }
    this.samples = this.samples.filter((s) => s.id !== id);
    forgetSample(id);
    for (const [i, s] of this.sketches.entries()) {
      if (s.noteSampleId === id) this.sketches[i] = { ...s, noteSampleId: null };
    }
    this.touchSampleUsers(id);
    this.toast('Sample deleted.');
  }

  /** Play a sketch's notes with a sample (null: the piano). */
  async setNoteSample(id: string, sampleId: string | null) {
    try {
      this.upsert(await this.library.setNoteSample(id, sampleId));
    } catch (error) {
      this.toast(`Could not change how the notes play: ${errorMessage(error)}`, 'error');
    }
  }

  /** Sketches that play a sample (their notes, or a rhythm's pads) sound different now. */
  private touchSampleUsers(sampleId: string) {
    for (const s of this.sketches) {
      if (s.noteSampleId === sampleId || s.rhythm?.samples?.includes(sampleId)) this.touch(s.id);
    }
  }

  /** The sample library: a grid of samples. */
  openSamples() {
    if (this.view.name === 'samples') return;
    history.pushState(null, '', '#/samples');
    this.view = { name: 'samples' };
  }

  // ------------------------------------------------------------- navigation

  openSketch(id: string) {
    history.pushState(null, '', `#/sketch/${id}`);
    this.view = { name: 'sketch', id };
  }

  /** The Reference section: chords by root, and the circle of fifths. */
  openReference() {
    history.pushState(null, '', '#/reference');
    this.view = { name: 'reference' };
  }

  /**
   * Chords tapped on the circle of fifths (their notes, from the first tap),
   * saved as a sketch at the end of the open notebook: the built-in piano
   * plays them, and they are its notes (nothing to transcribe).
   */
  async saveChordSketch(notes: PianoNote[], title: string, chords: string[]): Promise<Sketch | null> {
    const notebook = this.notebook;
    if (!notebook) return null;
    try {
      const sketch = await notesSketch(
        { library: this.library },
        notes,
        title,
        { notebookId: notebook.id, canvasXMs: Math.round((this.canvasEnd() + 1) * 1000), canvasY: 40 },
        { engine: CHORD_TAPS_ENGINE, params: { chords }, captureBackend: CHORD_TAPS_BACKEND },
      );
      this.upsert(sketch);
      this.toast(`Saved “${title}” at the end of ${notebook.title || 'the notebook'}.`, 'info', {
        label: 'Show',
        run: () => this.goHome(),
      });
      return sketch;
    } catch (error) {
      this.toast(`Could not save the chords: ${errorMessage(error)}`, 'error');
      return null;
    }
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
    if (sketch.parentId) this.touch(sketch.parentId);
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

  async setListenMode(id: string, listenMode: ListenMode) {
    const sketch = this.sketches.find((s) => s.id === id);
    if (sketch) this.upsert({ ...sketch, listenMode });
    // Rapid taps must reach storage in order; an older reply must not undo
    // the latest selection or change what the canvas plays while saving.
    const save = (this.listenSaves.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.library.update({ id, listenMode }));
    this.listenSaves.set(id, save);
    try {
      const saved = await save;
      if (this.listenSaves.get(id) === save) this.upsert(saved);
    } catch (error) {
      if (this.listenSaves.get(id) === save) {
        const saved = await this.library.get(id);
        if (this.listenSaves.get(id) === save) this.upsert(saved);
      }
      throw error;
    } finally {
      if (this.listenSaves.get(id) === save) this.listenSaves.delete(id);
    }
  }

  async deleteSketch(id: string) {
    await this.deleteSketches([id]);
  }

  async deleteSketches(ids: string[]) {
    const gone = new Set(ids);
    for (const s of this.sketches) if (s.parentId && gone.has(s.parentId)) gone.add(s.id);
    for (const id of gone) this.queue.cancel(id);
    for (const id of ids) await this.library.remove(id);
    this.sketches = this.sketches.filter((s) => !gone.has(s.id));
    if (this.view.name === 'sketch' && gone.has(this.view.id)) this.goHome();
    this.toast(ids.length === 1 ? 'Sketch deleted.' : `${ids.length} sketches deleted.`);
  }

  /** Delete a track of a sketch with all of its takes. */
  async deleteTrack(sketchId: string, trackId: string) {
    const takes = this.sketches.filter((s) => s.trackId === trackId).map((s) => s.id);
    for (const take of takes) this.queue.cancel(take);
    await this.library.removeTrack(trackId);
    const gone = new Set(takes);
    this.sketches = this.sketches.filter((s) => !gone.has(s.id));
    this.touch(sketchId);
    this.toast('Track deleted.');
  }

  /** Delete one take of a track (its track then plays its latest other take). */
  async deleteTake(sketchId: string, takeId: string) {
    this.queue.cancel(takeId);
    await this.library.removeTake(takeId);
    this.sketches = this.sketches.filter((s) => s.id !== takeId);
    this.touch(sketchId);
    this.toast('Take deleted.');
  }

  /** Open the export sheet for one or more sketches. */
  shareSketches(ids: string[]) {
    if (ids.length > 0) this.exportRequest = [...ids];
  }

  /** Dependencies for the exporter (storage + native capture helpers). */
  exportDeps() {
    return {
      library: this.library,
      capture: this.captureEngine,
      samples: this.sampleSound,
      noteSample: async (id: string) => {
        const sample = this.sample(id);
        const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
        // Any context can make the buffer; the export renders it at its own rate.
        return sample && Offline ? pitchedSample(new Offline(1, 1, 44100), sample) : null;
      },
    };
  }

  transcribe(id: string, model: TranscriptionModel = 'basic-pitch') {
    this.queue.enqueue(id, getTranscriptionEngine(model, this.settings.transcription));
  }

  /** Change part of the transcription settings (applies to the next transcription). */
  updateTranscription(patch: Partial<TranscriptionSettings>) {
    this.updateSettings({ transcription: { ...this.settings.transcription, ...patch } });
  }

  updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    if (patch.audioOutput !== undefined) setOutputDevice(patch.audioOutput);
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
      `web audio session: ${webAudioSessionSummary()}`,
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
    // All logs start with a local HH:MM:SS.mmm timestamp.
    const merged = [...this.captureLog, ...nativeLines, ...(this.watch?.log ?? [])].sort((a, b) => a.slice(0, 12).localeCompare(b.slice(0, 12)));
    return [...header, '', ...merged].join('\n');
  }

  // --------------------------------------------------------------- capture

  /**
   * One tap: permissions (first time only), reserve a sketch, record.
   * A start that fails, times out, or dies within the first moments is
   * retried once automatically before the user sees an error.
   */
  async startRecording(options: { retry?: boolean; take?: TakeTarget; canvas?: CanvasTarget } = {}) {
    const engine = this.captureEngine;
    if (this.recording && !options.retry) return;
    if (!engine) {
      this.toast('Recording is not available on this device.', 'error');
      (options.take ?? options.canvas)?.onEnd?.(null);
      return;
    }
    if (!options.retry) {
      this.releaseCaptureSession = beginCaptureSession((message) => this.logCapture(message));
      this.takeTarget = options.take ?? null;
      this.canvasTarget = options.take ? null : (options.canvas ?? null);
      // Still inside the tap: the only moment iOS lets audio start.
      if (this.settings.countIn) this.metronome.prepare();
    }
    const take = this.takeTarget;
    const canvas = this.canvasTarget;
    const native = engine.nativePreview;
    const settings: CaptureSettings = {
      camera: this.settings.camera,
      lens: this.settings.lens,
      rawAudio: this.settings.rawAudio,
      input: native ? this.settings.iosInput : this.settings.audioInput,
      output: native ? this.settings.iosOutput : undefined,
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
      // Onto a canvas, recording happens in a strip on the canvas: no full-screen camera preview.
      nativePreview: engine.nativePreview && wantsVideo && !canvas,
      warning: retry ? RESTARTING : null,
      countIn: null,
      downbeatMs: null,
      playFrom: null,
      take: take ? { sketchId: take.sketchId, trackId: take.trackId, label: take.label } : null,
      canvas: canvas ? { notebookId: canvas.notebookId, at: canvas.at, y: canvas.y } : null,
      pulse: null,
    };
    this.lastLevel = null;
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
        ...(take ? { parentId: take.sketchId, trackId: take.trackId ?? undefined } : {}),
        // Placed where it was pressed until the downbeat says exactly where.
        ...(canvas ? { notebookId: canvas.notebookId, canvasXMs: Math.round(canvas.at * 1000), canvasY: canvas.y } : {}),
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
        // A warning raised while starting (e.g. the chosen microphone is missing) stays; "Restarting…" goes.
        warning: this.recording.warning === RESTARTING ? null : this.recording.warning,
      };
      const early = this.pendingFinish;
      if (early) {
        this.pendingFinish = null;
        this.recording = { ...this.recording, phase: 'saving' };
        await this.finishRecording(early, false);
        return;
      }
      void this.countInThenPlay(attempt);
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

  /** What is being recorded into: a sketch (a take) or a canvas. */
  private get target(): TakeTarget | CanvasTarget | null {
    return this.takeTarget ?? this.canvasTarget;
  }

  /** Where the recorder is in the take right now (ms), by its own clock where possible. */
  private recordingElapsedMs(): number {
    const now = performance.now();
    const level = this.lastLevel;
    if (level) return level.elapsedMs + (now - level.at);
    return now - (this.recording?.startedAt ?? now);
  }

  /**
   * Once the recorder runs: the count-in, then the downbeat. A take into an
   * open sketch starts the other tracks there.
   */
  private async countInThenPlay(attempt: number) {
    if (this.settings.countIn) {
      const abort = new AbortController();
      this.countInAbort = abort;
      const recording = this.recording;
      if (recording) recording.countIn = { beat: 0, beats: COUNT_IN_BEATS };
      if (!this.metronome.audible) this.logCapture('count-in without sound (no running audio context)');
      const reached = await this.metronome.run({
        beats: COUNT_IN_BEATS,
        // Into a sketch, or over a rhythm: at its tempo, so the take starts in time with it.
        bpm: this.target?.tempo?.bpm ?? this.settings.countInBpm,
        signal: abort.signal,
        onBeat: (beat) => {
          if (attempt === this.attempt && this.recording?.countIn) this.recording.countIn.beat = beat;
        },
      });
      if (this.countInAbort === abort) this.countInAbort = null;
      if (!reached || attempt !== this.attempt || this.recording?.phase !== 'recording') return;
      this.recording.countIn = null;
    }
    const recording = this.recording;
    if (!recording || attempt !== this.attempt || recording.phase !== 'recording') return;
    recording.downbeatMs = Math.max(0, this.recordingElapsedMs());
    const downbeatAt = performance.now();
    const target = this.target;
    if (target?.onDownbeat) {
      try {
        recording.playFrom = target.onDownbeat();
      } catch (error) {
        this.logCapture(`could not start the other tracks: ${errorMessage(error)}`);
      }
    }
    const tempo = target?.tempo;
    if (tempo && tempo.bpm > 0) {
      // The sketch's beats from here on, on the clock the dot is drawn with.
      const period = 60 / tempo.bpm;
      const from = recording.playFrom ?? 0;
      const next = tempo.beat + Math.ceil((from - tempo.beat - 1e-6) / period) * period;
      recording.pulse = { firstBeatAt: downbeatAt + (next - from) * 1000, periodMs: period * 1000 };
    }
    this.logCapture(
      `downbeat at ${Math.round(recording.downbeatMs)} ms into the take` +
        (recording.playFrom !== null ? `; other tracks from ${recording.playFrom.toFixed(2)} s` : ''),
    );
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
    const counting = recording.countIn !== null;
    if (performance.now() < recording.armedAt && !counting) {
      this.logCapture('ignored a stop tap right after recording started');
      return;
    }
    this.countInAbort?.abort();
    this.recording = { ...recording, phase: 'saving' };
    this.logCapture(counting ? 'stopped during the count-in: cancelling the take' : 'stop tapped');
    if (counting) {
      await active.stop().catch(() => {});
      await this.cancelRecording();
      return;
    }
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
        this.lastLevel = { elapsedMs: event.elapsedMs, at: performance.now() };
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

  /** Stopped during the count-in: nothing was played, so nothing is kept. */
  private async cancelRecording() {
    const id = this.recording?.sketchId;
    const take = this.recording?.take;
    this.active = null;
    document.documentElement.classList.remove('native-preview');
    if (id) await this.library.discard(id).catch(() => {});
    // A take for a new track had created the track: the open sketch drops it again.
    if (take) this.touch(take.sketchId);
    this.endRecordingUi();
    this.toast('Recording cancelled.');
    void this.refresh();
  }

  private async finishRecording(result: RecordingResult, userStopped: boolean) {
    const recording = this.recording;
    const id = recording?.sketchId;
    this.active = null;
    this.countInAbort?.abort();
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
      if (recording?.take) this.touch(recording.take.sketchId);
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

    const take = recording?.take ?? null;
    const downbeatMs = recording?.downbeatMs ?? null;
    // A take into a sketch is placed so its downbeat meets the point where the
    // other tracks started; without a count-in the downbeat is the take's start.
    const offsetMs = take
      ? Math.round((recording?.playFrom ?? 0) * 1000 - (downbeatMs ?? 0))
      : undefined;
    // On a canvas the same way: the downbeat lands where the canvas was heard at that moment.
    const canvas = recording?.canvas ?? null;
    const canvasXMs = canvas ? Math.round((recording?.playFrom ?? canvas.at) * 1000 - (downbeatMs ?? 0)) : undefined;
    let saved: Sketch | null = null;
    const countedIn = recording?.countIn === null && downbeatMs !== null && this.settings.countIn;
    try {
      let sketch = await this.library.finalize({
        id,
        durationMs: Math.round(result.durationMs) || null,
        hasVideo: result.hasVideo,
        videoWidth: result.width ?? null,
        videoHeight: result.height ?? null,
        offsetMs,
        countInMs: countedIn ? Math.round(downbeatMs!) : null,
        canvasXMs,
      });
      if (!take && countedIn) {
        // Until the notes say otherwise: the tempo it was counted in at, with a beat on the downbeat.
        const bpm = this.canvasTarget?.tempo?.bpm ?? this.settings.countInBpm;
        sketch = await this.library.setTempo(id, bpm, Math.round(downbeatMs!), 'count-in');
      }
      saved = sketch;
      this.logCapture(
        `saved ${Math.round(result.durationMs)} ms take${userStopped ? '' : ' (ended on its own)'}` +
          (take ? ` for ${take.label} at ${offsetMs} ms` : ''),
      );
      this.upsert(sketch);
      if (take) {
        this.touch(take.sketchId);
        this.toast(userStopped || result.ok ? `${take.label}: take saved.` : 'Recording was interrupted, but the take was saved.');
      } else if (canvas) {
        this.toast(userStopped || result.ok ? 'Sketch saved.' : 'Recording was interrupted, but the take was saved.');
      } else {
        this.toast(
          userStopped || result.ok ? 'Sketch saved.' : 'Recording was interrupted, but the take was saved.',
          'info',
          { label: 'Open', run: () => this.openSketch(id) },
        );
      }
      if (this.settings.autoTranscribe) this.queue.enqueue(id);
    } catch (error) {
      this.logCapture(`could not save the take: ${errorMessage(error)}`);
      await this.library.discard(id).catch(() => {});
      if (take) this.touch(take.sketchId);
      this.toast(`Nothing was recorded: ${errorMessage(error)}`, 'error');
    } finally {
      this.endRecordingUi(saved);
      void this.refresh();
    }
  }

  /** Tell open views that a sketch changed (e.g. a track was added). */
  touch(id: string) {
    this.revision[id] = (this.revision[id] ?? 0) + 1;
  }

  private endRecordingUi(saved: Sketch | null = null) {
    this.recording = null;
    this.queue.setPaused(false);
    this.countInAbort?.abort();
    this.countInAbort = null;
    const target = this.target;
    this.takeTarget = null;
    this.canvasTarget = null;
    if (this.settings.countIn) this.metronome.close();
    this.releaseCaptureSession?.();
    this.releaseCaptureSession = null;
    target?.onEnd?.(saved);
  }
}

export const app = new AppState();
