/**
 * Environment-agnostic Basic Pitch runner (browser worker, main thread or
 * Node tests). Wraps Spotify's basic-pitch-ts with:
 *  - per-window tensor disposal (the upstream `evaluateModel` keeps every
 *    intermediate tensor alive until the end, which exhausts GPU memory on
 *    long takes),
 *  - cancellation between windows,
 *  - conversion to the app's `PianoNote` contract.
 */
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import type { PianoNote } from './types';
import { TranscriptionAbortedError } from './types';
import {
  BASIC_PITCH_SAMPLE_RATE,
  DEFAULT_BASIC_PITCH_PARAMS,
  FRAMES_PER_SECOND,
  type BasicPitchParams,
  type ModelArtifacts,
  type ModelOutput,
} from './basicPitchParams';

export * from './basicPitchParams';

const FFT_HOP = 256;
const ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_SAMPLE_RATE / FFT_HOP);

/** Load the graph model from bytes already in memory (no network access). */
export function loadModel(artifacts: ModelArtifacts): Promise<tf.GraphModel> {
  const { json, weights } = artifacts;
  const handler: tf.io.IOHandler = {
    load: async () => ({
      modelTopology: json.modelTopology as tf.io.ModelArtifacts['modelTopology'],
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights) as tf.io.WeightsManifestEntry[],
      weightData: weights,
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy,
      signature: json.signature as object | undefined,
      userDefinedMetadata: json.userDefinedMetadata as Record<string, object> | undefined,
    }),
  };
  return tf.loadGraphModel(handler);
}

/** Pick the fastest available tfjs backend. Returns the backend name. */
export async function selectBackend(preferred: string[] = ['webgl', 'cpu']): Promise<string> {
  for (const name of preferred) {
    try {
      if (await tf.setBackend(name)) {
        await tf.ready();
        return tf.getBackend();
      }
    } catch {
      // try the next backend
    }
  }
  await tf.ready();
  return tf.getBackend();
}

/**
 * Run the model over mono 22.05 kHz audio in 2 s windows.
 * Mirrors `BasicPitch.evaluateModel` but frees tensors window by window.
 */
export async function runModel(
  model: tf.GraphModel,
  samples: Float32Array,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ModelOutput> {
  const basicPitch = new BasicPitch(Promise.resolve(model));
  const frames: number[][] = [];
  const onsets: number[][] = [];

  tf.engine().startScope();
  try {
    const [windows, originalLength] = await basicPitch.prepareData(samples);
    const totalFrames = Math.floor(originalLength * (ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE));
    const windowCount = windows.shape[0];

    for (let i = 0; i < windowCount && frames.length < totalFrames; i++) {
      if (signal?.aborted) throw new TranscriptionAbortedError();
      onProgress?.(i / windowCount);
      tf.engine().startScope();
      try {
        const [windowFrames, windowOnsets] = await basicPitch.evaluateSingleFrame(windows, i);
        let f = basicPitch.unwrapOutput(windowFrames);
        let o = basicPitch.unwrapOutput(windowOnsets);
        const remaining = totalFrames - frames.length;
        if (f.shape[0] > remaining) {
          f = f.slice([0, 0], [remaining, -1]);
          o = o.slice([0, 0], [remaining, -1]);
        }
        const [fa, oa] = await Promise.all([f.array(), o.array()]);
        for (const row of fa) frames.push(row);
        for (const row of oa) onsets.push(row);
      } finally {
        tf.engine().endScope();
      }
    }
  } finally {
    tf.engine().endScope();
  }
  onProgress?.(1);
  return { frames, onsets };
}

const round = (value: number, digits = 3) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Turn model activations into notes. Cheap; can be re-run with new params. */
export function notesFromModelOutput(
  output: ModelOutput,
  params: BasicPitchParams = DEFAULT_BASIC_PITCH_PARAMS,
): PianoNote[] {
  if (output.frames.length === 0) return [];
  // outputToNotesPoly mutates its inputs; keep the cached output intact.
  const frames = output.frames.map((row) => row.slice());
  const onsets = output.onsets.map((row) => row.slice());
  const minNoteFrames = Math.max(1, Math.round((params.minNoteLengthMs / 1000) * FRAMES_PER_SECOND));
  const events = noteFramesToTime(
    outputToNotesPoly(
      frames,
      onsets,
      params.onsetThreshold,
      params.frameThreshold,
      minNoteFrames,
      true,
      null,
      null,
      params.melodiaTrick,
      params.energyTolerance,
    ),
  );
  return events
    .map((event): PianoNote => {
      const amplitude = Math.min(1, Math.max(0, event.amplitude));
      const start = Math.max(0, event.startTimeSeconds);
      return {
        pitch: event.pitchMidi,
        startTime: round(start),
        endTime: round(Math.max(start + 0.01, event.startTimeSeconds + event.durationSeconds)),
        // Same mapping Basic Pitch uses when writing MIDI.
        velocity: Math.max(1, Math.min(127, Math.round(127 * amplitude))),
        confidence: round(amplitude),
      };
    })
    .filter((n) => n.pitch >= params.minPitch && n.pitch <= params.maxPitch)
    .sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}
