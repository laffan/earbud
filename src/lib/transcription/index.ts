import { BasicPitchEngine } from './basicPitchEngine';
import { DEFAULT_TRANSCRIPTION_SETTINGS, transcriptionParams } from './settings';
import { isIOSLike } from '../platform/tauri';
import { MobileDettatoEngine } from './dettatoMobile';
import { DettatoEngine } from './dettatoEngine';
import type { TranscriptionEngine } from './types';

export type { PianoNote, TranscriptionEngine, TranscribeOptions } from './types';
export { TranscriptionAbortedError } from './types';
export { DEFAULT_BASIC_PITCH_PARAMS, type BasicPitchParams } from './basicPitchParams';
export * from './settings';

const mobile = new MobileDettatoEngine();
const desktop = new DettatoEngine();
export type TranscriptionModel = 'basic-pitch' | 'dettato';

export function getTranscriptionEngine(model: TranscriptionModel = 'basic-pitch', settings = DEFAULT_TRANSCRIPTION_SETTINGS): TranscriptionEngine {
  if (model === 'dettato') return isIOSLike() ? mobile : desktop;
  return new BasicPitchEngine({
    params: transcriptionParams(settings),
    labels: { environment: settings.environment, heldNotes: settings.heldNotes },
  });
}
