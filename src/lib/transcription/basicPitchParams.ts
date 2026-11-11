/**
 * Basic Pitch constants, parameters and model artifact types. Kept free of
 * TensorFlow.js imports so the app shell can reference them without loading
 * tfjs (which is only loaded inside the transcription worker).
 */

/** Shape of a weight entry in a TF.js `model.json` manifest. */
export interface WeightSpec {
  name: string;
  shape: number[];
  dtype: 'float32' | 'int32' | 'bool' | 'string' | 'complex64';
  [key: string]: unknown;
}

export const BASIC_PITCH_VERSION = '1.0.1';
export const BASIC_PITCH_SAMPLE_RATE = 22050;
const FFT_HOP = 256;
/** Model output frames per second (~86.13). */
export const FRAMES_PER_SECOND = BASIC_PITCH_SAMPLE_RATE / FFT_HOP;

export interface BasicPitchParams {
  /** Onset peak threshold (Basic Pitch default 0.5). Lower finds more notes. */
  onsetThreshold: number;
  /** Frame activation threshold (default 0.3). Lower makes notes longer. */
  frameThreshold: number;
  /** Notes shorter than this are dropped (default ≈127.7 ms = 11 frames). */
  minNoteLengthMs: number;
  /** Recover notes without a clear onset (Basic Pitch "melodia trick"). */
  melodiaTrick: boolean;
  /** Frames a note may dip below the threshold before it ends. */
  energyTolerance: number;
  /** Lowest/highest MIDI pitch kept (piano range by default). */
  minPitch: number;
  maxPitch: number;
}

export const DEFAULT_BASIC_PITCH_PARAMS: Readonly<BasicPitchParams> = Object.freeze({
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteLengthMs: 127.7,
  melodiaTrick: true,
  energyTolerance: 11,
  minPitch: 21,
  maxPitch: 108,
});

/** Raw model activations, one row per output frame, 88 columns (A0…C8). */
export interface ModelOutput {
  frames: number[][];
  onsets: number[][];
}

export interface ModelArtifacts {
  /** Parsed `model.json`. */
  json: {
    modelTopology: unknown;
    weightsManifest: { paths: string[]; weights: WeightSpec[] }[];
    format?: string;
    generatedBy?: string;
    convertedBy?: string;
    signature?: unknown;
    userDefinedMetadata?: Record<string, unknown>;
  };
  /** Concatenated weight shards, in manifest order. */
  weights: ArrayBuffer;
}
