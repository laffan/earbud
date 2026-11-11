/**
 * Engine registry. The rest of the app asks for "the transcription engine"
 * and never imports a concrete model, so swapping Basic Pitch for another
 * model (or a native Core ML backend) is a one-line change here.
 */
import { BasicPitchEngine } from './basicPitchEngine';
import type { BasicPitchParams } from './basicPitchParams';
import type { TranscriptionEngine } from './types';

export type { PianoNote, TranscriptionEngine, TranscribeOptions } from './types';
export { TranscriptionAbortedError } from './types';
export { DEFAULT_BASIC_PITCH_PARAMS, type BasicPitchParams } from './basicPitchParams';

/** Sensitivity presets exposed in Settings. */
export type Sensitivity = 'conservative' | 'balanced' | 'sensitive';

export const SENSITIVITY_PARAMS: Record<Sensitivity, Partial<BasicPitchParams>> = {
  conservative: { onsetThreshold: 0.6, frameThreshold: 0.35 },
  balanced: {},
  sensitive: { onsetThreshold: 0.4, frameThreshold: 0.25, minNoteLengthMs: 90 },
};

const engines = new Map<Sensitivity, TranscriptionEngine>();

export function getTranscriptionEngine(sensitivity: Sensitivity = 'balanced'): TranscriptionEngine {
  let engine = engines.get(sensitivity);
  if (!engine) {
    engine = new BasicPitchEngine({ params: SENSITIVITY_PARAMS[sensitivity] });
    engines.set(sensitivity, engine);
  }
  return engine;
}
