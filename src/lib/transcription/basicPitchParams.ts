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

  // Piano-specific clean-up after Basic Pitch's own decoding (noteCleanup.ts).

  /** Stitch the fragments of a note that was held while others were played. */
  joinHeldNotes: boolean;
  /** Longest silence at a pitch that joining bridges (ms). */
  joinMaxGapMs: number;
  /**
   * Onset activation a note of the same pitch needs at its start to count as
   * the key being struck again rather than still held (0–1).
   */
  restrikeOnset: number;
  /**
   * Frame activation such a note also needs right after its onset (0–1).
   * 0 trusts the onset alone; higher values also join weak re-strikes.
   */
  restrikeAttack: number;
  /**
   * Onset activation a note needs at its start to count as a key strike at
   * all (0–1); used by `dropUnstruck`.
   */
  strikeOnset: number;
  /** Drop notes that have no key strike and continue no earlier note. */
  dropUnstruck: boolean;
  /**
   * Drop notes this many dB quieter than the loud notes of the take
   * (background sounds); null turns the gate off.
   */
  noiseGateDb: number | null;
}

export const DEFAULT_BASIC_PITCH_PARAMS: Readonly<BasicPitchParams> = Object.freeze({
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteLengthMs: 127.7,
  melodiaTrick: true,
  energyTolerance: 11,
  minPitch: 21,
  maxPitch: 108,
  joinHeldNotes: true,
  joinMaxGapMs: 1500,
  restrikeOnset: 0.6,
  restrikeAttack: 0,
  strikeOnset: 0.5,
  dropUnstruck: false,
  noiseGateDb: null,
});

/** Raw model activations, one row per output frame, 88 columns (A0…C8). */
export interface ModelOutput {
  frames: number[][];
  onsets: number[][];
}

/** What a runner needs to turn a take into notes again without running the model. */
export interface CachedTake {
  output: ModelOutput;
  /** The 22.05 kHz analysis audio the activations came from. */
  samples: Float32Array;
}

/**
 * Keeps the activations of the last few takes in memory, so transcribing a
 * take again with other settings (another environment, held-note joining)
 * only repeats the cheap note decoding, not the model.
 */
export class TakeCache {
  private entries = new Map<string, CachedTake>();

  constructor(
    /** Takes kept. One covers the usual case: transcribing the open sketch again. */
    private readonly limit = 1,
    /**
     * Longest take worth keeping (frames; ~86 per second). Five minutes of
     * activations and audio take roughly 50 MB, which an iPhone tolerates.
     */
    private readonly maxFrames = Math.round(FRAMES_PER_SECOND * 60 * 5),
  ) {}

  /** The cached take for `key`, if it is the same audio. */
  get(key: string, sampleCount: number): CachedTake | null {
    const entry = this.entries.get(key);
    if (!entry || entry.samples.length !== sampleCount) return null;
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, take: CachedTake) {
    this.entries.delete(key);
    if (take.output.frames.length > this.maxFrames) return;
    this.entries.set(key, take);
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }
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
