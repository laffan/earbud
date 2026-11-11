/**
 * Basic Pitch implementation of the TranscriptionEngine contract.
 *
 * Inference runs in a Web Worker. If the worker cannot get a WebGL context
 * (OffscreenCanvas WebGL needs iOS 17+) but the page can, the engine falls
 * back to running on the main thread with WebGL, which is still far faster
 * than CPU inference in a worker.
 */
import { loadAnalysisSamples } from '../audio/analysisAudio';
import {
  BASIC_PITCH_SAMPLE_RATE,
  BASIC_PITCH_VERSION,
  DEFAULT_BASIC_PITCH_PARAMS,
  type BasicPitchParams,
  type ModelArtifacts,
} from './basicPitchParams';
import type { WorkerRequest, WorkerResponse } from './basicPitch.worker';
import {
  TranscriptionAbortedError,
  type PianoNote,
  type TranscribeOptions,
  type TranscriptionEngine,
} from './types';

const MODEL_URL = 'models/basic-pitch/model.json';

let modelPromise: Promise<ModelArtifacts> | null = null;

/** Fetch the bundled model once (served from the app bundle, offline). */
export function fetchModelArtifacts(baseUrl: string = document.baseURI): Promise<ModelArtifacts> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const jsonUrl = new URL(MODEL_URL, baseUrl);
      const response = await fetch(jsonUrl);
      if (!response.ok) throw new Error(`Could not load the transcription model (${response.status})`);
      const json = (await response.json()) as ModelArtifacts['json'];
      const paths = json.weightsManifest.flatMap((group) => group.paths);
      const shards = await Promise.all(
        paths.map(async (p) => {
          const r = await fetch(new URL(p, jsonUrl));
          if (!r.ok) throw new Error(`Could not load model weights (${r.status})`);
          return new Uint8Array(await r.arrayBuffer());
        }),
      );
      const total = shards.reduce((n, s) => n + s.byteLength, 0);
      const weights = new Uint8Array(total);
      let offset = 0;
      for (const shard of shards) {
        weights.set(shard, offset);
        offset += shard.byteLength;
      }
      return { json, weights: weights.buffer };
    })().catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

function pageHasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Runners that were terminated (e.g. by cancellation) and must be rebuilt. */
const disposed = new WeakSet<object>();

interface Runner {
  readonly backend: string;
  readonly context: 'worker' | 'main';
  run(
    samples: Float32Array,
    params: BasicPitchParams,
    onProgress: (f: number) => void,
    signal?: AbortSignal,
  ): Promise<PianoNote[]>;
  dispose(): void;
}

class WorkerRunner implements Runner {
  readonly context = 'worker' as const;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (n: PianoNote[]) => void; reject: (e: Error) => void; onProgress: (f: number) => void }
  >();

  private constructor(
    private worker: Worker,
    readonly backend: string,
  ) {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'Transcription worker crashed'));
  }

  static async create(model: ModelArtifacts, backends: string[]): Promise<WorkerRunner> {
    const worker = new Worker(new URL('./basicPitch.worker.ts', import.meta.url), { type: 'module' });
    const backend = await new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'ready') resolve(event.data.backend);
        else if (event.data.type === 'error') reject(new Error(event.data.message));
      };
      worker.onerror = (event) => reject(new Error(event.message || 'Could not start transcription worker'));
      // Copy the weights: the cached ArrayBuffer is reused if the worker restarts.
      const message: WorkerRequest = {
        type: 'init',
        model: { json: model.json, weights: model.weights.slice(0) },
        backends,
      };
      worker.postMessage(message);
    }).catch((error) => {
      worker.terminate();
      throw error;
    });
    return new WorkerRunner(worker, backend);
  }

  private handle(message: WorkerResponse) {
    if (message.type === 'progress') {
      this.pending.get(message.id)?.onProgress(message.fraction);
    } else if (message.type === 'result') {
      this.pending.get(message.id)?.resolve(message.notes);
      this.pending.delete(message.id);
    } else if (message.type === 'error') {
      if (message.id === null) {
        this.failAll(new Error(message.message));
      } else {
        this.pending.get(message.id)?.reject(new Error(message.message));
        this.pending.delete(message.id);
      }
    }
  }

  private failAll(error: Error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  run(samples: Float32Array, params: BasicPitchParams, onProgress: (f: number) => void, signal?: AbortSignal) {
    const id = this.nextId++;
    return new Promise<PianoNote[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      signal?.addEventListener(
        'abort',
        () => {
          // Inference cannot be interrupted mid-window; kill the worker.
          this.pending.get(id)?.reject(new TranscriptionAbortedError());
          this.pending.delete(id);
          this.dispose();
        },
        { once: true },
      );
      const message: WorkerRequest = { type: 'transcribe', id, samples, params };
      this.worker.postMessage(message, [samples.buffer]);
    });
  }

  dispose() {
    this.worker.terminate();
    this.failAll(new TranscriptionAbortedError());
    disposed.add(this);
  }
}

class MainThreadRunner implements Runner {
  readonly context = 'main' as const;
  private constructor(
    private model: import('@tensorflow/tfjs').GraphModel,
    readonly backend: string,
  ) {}

  static async create(model: ModelArtifacts): Promise<MainThreadRunner> {
    const core = await import('./basicPitchCore');
    const backend = await core.selectBackend(['webgl', 'cpu']);
    return new MainThreadRunner(await core.loadModel(model), backend);
  }

  async run(samples: Float32Array, params: BasicPitchParams, onProgress: (f: number) => void, signal?: AbortSignal) {
    const core = await import('./basicPitchCore');
    const output = await core.runModel(this.model, samples, onProgress, signal);
    return core.notesFromModelOutput(output, params);
  }

  dispose() {
    this.model.dispose();
    disposed.add(this);
  }
}

export interface BasicPitchEngineOptions {
  params?: Partial<BasicPitchParams>;
  /** Force where inference runs (default: automatic). */
  context?: 'auto' | 'worker' | 'main';
  /** Override how analysis audio is loaded (tests, alternate storage). */
  loadSamples?: (path: string) => Promise<Float32Array>;
}

export class BasicPitchEngine implements TranscriptionEngine {
  readonly id = 'basic-pitch';
  readonly version = BASIC_PITCH_VERSION;
  readonly params: Readonly<BasicPitchParams>;
  private runner: Promise<Runner> | null = null;
  private readonly context: 'auto' | 'worker' | 'main';
  private readonly loadSamples: (path: string) => Promise<Float32Array>;

  constructor(options: BasicPitchEngineOptions = {}) {
    this.params = Object.freeze({ ...DEFAULT_BASIC_PITCH_PARAMS, ...options.params });
    this.context = options.context ?? 'auto';
    this.loadSamples = options.loadSamples ?? ((p) => loadAnalysisSamples(p, BASIC_PITCH_SAMPLE_RATE));
  }

  /** Where and how inference runs, once the engine has warmed up. */
  async describe(): Promise<{ context: string; backend: string }> {
    const runner = await this.getRunner();
    return { context: runner.context, backend: runner.backend };
  }

  private getRunner(): Promise<Runner> {
    if (this.runner) {
      const current = this.runner;
      return current.then((r) => {
        if (!disposed.has(r)) return r;
        this.runner = null;
        return this.getRunner();
      });
    }
    this.runner = (async () => {
      const model = await fetchModelArtifacts();
      if (this.context === 'main') return MainThreadRunner.create(model);
      try {
        const worker = await WorkerRunner.create(model, ['webgl', 'cpu']);
        if (this.context === 'auto' && worker.backend !== 'webgl' && pageHasWebGL()) {
          worker.dispose();
          return MainThreadRunner.create(model);
        }
        return worker;
      } catch (error) {
        if (this.context === 'worker') throw error;
        return MainThreadRunner.create(model);
      }
    })().catch((error) => {
      this.runner = null;
      throw error;
    });
    return this.runner;
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<PianoNote[]> {
    const { onProgress, signal } = options;
    if (signal?.aborted) throw new TranscriptionAbortedError();
    const [samples, runner] = await Promise.all([this.loadSamples(audioPath), this.getRunner()]);
    if (signal?.aborted) throw new TranscriptionAbortedError();
    if (samples.length < BASIC_PITCH_SAMPLE_RATE * 0.25) return [];
    return runner.run(samples, { ...this.params }, (f) => onProgress?.(f), signal);
  }
}
