/**
 * Transcription Engine contract.
 *
 * The UI, library and music engine only depend on these types, so Basic Pitch
 * can be swapped for a more accurate model (or a native Core ML backend, or a
 * fused audio + vision model) without touching anything else.
 */

/** One note event. Times are seconds from the start of the recording. */
export interface PianoNote {
  /** MIDI note number (21 = A0 … 108 = C8). */
  pitch: number;
  startTime: number;
  endTime: number;
  /** MIDI velocity, 0–127. */
  velocity: number;
  /** Engine confidence, 0–1, when the engine provides one. */
  confidence?: number;
}

export interface TranscribeOptions {
  /** Called with a fraction in [0, 1]. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface TranscriptionEngine {
  /** Stable identifier stored with every transcription, e.g. `basic-pitch`. */
  readonly id: string;
  readonly version: string;
  /** Parameters that influence the output; stored for reproducibility. */
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Transcribe the analysis audio at `audioPath` (a 22.05 kHz mono WAV on
   * disk, produced from the original recording by the capture engine).
   */
  transcribe(audioPath: string, options?: TranscribeOptions): Promise<PianoNote[]>;
}

export class TranscriptionAbortedError extends Error {
  constructor() {
    super('Transcription was cancelled');
    this.name = 'TranscriptionAbortedError';
  }
}
