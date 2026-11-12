/**
 * Engine registry. The rest of the app asks for "the transcription engine"
 * and never imports a concrete model, so swapping Basic Pitch for another
 * model (or a native Core ML backend) is a one-line change here.
 */
import { BasicPitchEngine } from './basicPitchEngine';
import { DEFAULT_TRANSCRIPTION_SETTINGS, transcriptionParams, type TranscriptionSettings } from './settings';
import type { TranscriptionEngine } from './types';

export type { PianoNote, TranscriptionEngine, TranscribeOptions } from './types';
export { TranscriptionAbortedError } from './types';
export { DEFAULT_BASIC_PITCH_PARAMS, type BasicPitchParams } from './basicPitchParams';
export * from './settings';

const engines = new Map<string, TranscriptionEngine>();

/**
 * The engine for these settings. Engines are cheap: they share one worker and
 * one loaded model, and differ only in how activations are turned into notes.
 */
export function getTranscriptionEngine(
  settings: TranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS,
): TranscriptionEngine {
  const params = transcriptionParams(settings);
  const labels = { environment: settings.environment, heldNotes: settings.heldNotes };
  const key = JSON.stringify([params, labels]);
  let engine = engines.get(key);
  if (!engine) {
    if (engines.size > 16) engines.clear();
    engine = new BasicPitchEngine({ params, labels });
    engines.set(key, engine);
  }
  return engine;
}
