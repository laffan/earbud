/**
 * Transcription settings the user chooses, and the decoding parameters they
 * stand for. Two independent choices:
 *
 *  - the **environment** decides how much evidence a note needs before it is
 *    kept (background sounds become notes otherwise),
 *  - **held notes** decides whether fragments of a note that was held while
 *    others were played are joined back together.
 *
 * Kept free of TensorFlow.js imports so Settings can use it without loading
 * the model.
 */
import type { BasicPitchParams } from './basicPitchParams';

export type Environment = 'quiet' | 'room' | 'noisy' | 'custom';
export type HeldNotes = 'off' | 'join' | 'strong';

/** The noise-related knobs, adjustable one by one in the `custom` environment. */
export interface NoiseSettings {
  /** Drop notes this many dB quieter than the take's loud notes; null = keep all. */
  noiseGateDb: number | null;
  /** Keep only notes that begin with a key strike (or continue one). */
  requireStrike: boolean;
  /** Onset activation that counts as a key strike (0–1). */
  strikeOnset: number;
  /** Notes shorter than this are dropped (ms). */
  minNoteLengthMs: number;
}

export interface TranscriptionSettings {
  environment: Environment;
  heldNotes: HeldNotes;
  /** Used when `environment` is `custom`. */
  custom: NoiseSettings;
}

export const ENVIRONMENTS: Record<Exclude<Environment, 'custom'>, NoiseSettings> = {
  // Everything Basic Pitch finds: best when the piano is the only sound.
  quiet: { noiseGateDb: null, requireStrike: false, strikeOnset: 0.5, minNoteLengthMs: 127.7 },
  // Only what is far below the piano's level is removed.
  room: { noiseGateDb: 28, requireStrike: false, strikeOnset: 0.5, minNoteLengthMs: 127.7 },
  // Talking, a TV, traffic: a note must be struck, reasonably loud and not too short.
  noisy: { noiseGateDb: 20, requireStrike: true, strikeOnset: 0.6, minNoteLengthMs: 150 },
};

export const HELD_NOTES: Record<
  HeldNotes,
  Pick<BasicPitchParams, 'joinHeldNotes' | 'joinMaxGapMs' | 'restrikeOnset' | 'restrikeAttack'>
> = {
  off: { joinHeldNotes: false, joinMaxGapMs: 0, restrikeOnset: 0.6, restrikeAttack: 0 },
  // Joins fragments that have no onset of their own. Never joins a note that
  // the model heard being struck.
  join: { joinHeldNotes: true, joinMaxGapMs: 1500, restrikeOnset: 0.6, restrikeAttack: 0 },
  // Also joins weak onsets (a held note excited by its octave being struck),
  // at the risk of joining a soft repeated note inside a chord.
  strong: { joinHeldNotes: true, joinMaxGapMs: 3000, restrikeOnset: 0.6, restrikeAttack: 0.65 },
};

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  environment: 'room',
  heldNotes: 'join',
  custom: { ...ENVIRONMENTS.room },
};

/** The noise knobs in effect for these settings. */
export function noiseSettings(settings: TranscriptionSettings): NoiseSettings {
  return settings.environment === 'custom' ? settings.custom : ENVIRONMENTS[settings.environment];
}

/** Decoding parameters for these settings (on top of the Basic Pitch defaults). */
export function transcriptionParams(settings: TranscriptionSettings): Partial<BasicPitchParams> {
  const noise = noiseSettings(settings);
  return {
    ...HELD_NOTES[settings.heldNotes],
    noiseGateDb: noise.noiseGateDb,
    dropUnstruck: noise.requireStrike,
    strikeOnset: noise.strikeOnset,
    minNoteLengthMs: noise.minNoteLengthMs,
  };
}

const ENVIRONMENT_NAMES: Record<Environment, string> = {
  quiet: 'Quiet room',
  room: 'Normal room',
  noisy: 'Noisy room',
  custom: 'Custom',
};

export function environmentName(environment: Environment): string {
  return ENVIRONMENT_NAMES[environment];
}

/** Fill in anything missing or invalid in stored settings (older versions, hand edits). */
export function normalizeTranscriptionSettings(value: unknown, legacySensitivity?: unknown): TranscriptionSettings {
  const defaults = DEFAULT_TRANSCRIPTION_SETTINGS;
  const input = (value && typeof value === 'object' ? value : {}) as Partial<TranscriptionSettings>;
  let environment: Environment = defaults.environment;
  if (input.environment && input.environment in ENVIRONMENT_NAMES) environment = input.environment;
  else if (legacySensitivity === 'conservative') environment = 'noisy';
  else if (legacySensitivity === 'sensitive') environment = 'quiet';
  const heldNotes: HeldNotes = input.heldNotes && input.heldNotes in HELD_NOTES ? input.heldNotes : defaults.heldNotes;
  const c = (input.custom && typeof input.custom === 'object' ? input.custom : {}) as Partial<NoiseSettings>;
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const custom: NoiseSettings = {
    noiseGateDb: c.noiseGateDb === null ? null : number(c.noiseGateDb, defaults.custom.noiseGateDb ?? 28, 6, 60),
    requireStrike: typeof c.requireStrike === 'boolean' ? c.requireStrike : defaults.custom.requireStrike,
    strikeOnset: number(c.strikeOnset, defaults.custom.strikeOnset, 0.2, 0.95),
    minNoteLengthMs: number(c.minNoteLengthMs, defaults.custom.minNoteLengthMs, 40, 500),
  };
  return { environment, heldNotes, custom };
}
