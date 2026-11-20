import { isIOSLike } from '../platform/tauri';
import { MobileDettatoEngine } from './dettatoMobile';
import { DettatoEngine } from './dettatoEngine';
import type { TranscriptionEngine } from './types';

export type { PianoNote, TranscriptionEngine, TranscribeOptions } from './types';
export { TranscriptionAbortedError } from './types';
export { DEFAULT_BASIC_PITCH_PARAMS, type BasicPitchParams } from './basicPitchParams';
export * from './settings';

const mobile = new MobileDettatoEngine();
const engine = new DettatoEngine();

export function getTranscriptionEngine(): TranscriptionEngine {
  return isIOSLike() ? mobile : engine;
}
