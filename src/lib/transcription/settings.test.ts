import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  ENVIRONMENTS,
  normalizeTranscriptionSettings,
  transcriptionParams,
} from './settings';

describe('transcription settings', () => {
  it('maps an environment and a held-note mode to decoding parameters', () => {
    expect(transcriptionParams({ ...DEFAULT_TRANSCRIPTION_SETTINGS, environment: 'noisy', heldNotes: 'off' })).toMatchObject({
      joinHeldNotes: false,
      noiseGateDb: ENVIRONMENTS.noisy.noiseGateDb,
      dropUnstruck: true,
      strikeOnset: 0.6,
      minNoteLengthMs: 150,
    });
    expect(transcriptionParams({ ...DEFAULT_TRANSCRIPTION_SETTINGS, environment: 'quiet' })).toMatchObject({
      joinHeldNotes: true,
      noiseGateDb: null,
      dropUnstruck: false,
    });
  });

  it('uses the custom values only in the custom environment', () => {
    const custom = { noiseGateDb: 12, requireStrike: true, strikeOnset: 0.8, minNoteLengthMs: 200 };
    const settings = { environment: 'custom' as const, heldNotes: 'join' as const, custom };
    expect(transcriptionParams(settings)).toMatchObject({ noiseGateDb: 12, dropUnstruck: true, strikeOnset: 0.8, minNoteLengthMs: 200 });
    expect(transcriptionParams({ ...settings, environment: 'room' })).toMatchObject({ noiseGateDb: 28, dropUnstruck: false });
  });

  it('carries over the sensitivity setting of earlier versions', () => {
    expect(normalizeTranscriptionSettings(undefined, 'conservative').environment).toBe('noisy');
    expect(normalizeTranscriptionSettings(undefined, 'sensitive').environment).toBe('quiet');
    expect(normalizeTranscriptionSettings(undefined, 'balanced')).toEqual(DEFAULT_TRANSCRIPTION_SETTINGS);
  });

  it('repairs invalid stored values', () => {
    const repaired = normalizeTranscriptionSettings({
      environment: 'stadium',
      heldNotes: 'always',
      custom: { noiseGateDb: 500, requireStrike: 'yes', strikeOnset: Number.NaN, minNoteLengthMs: 5 },
    });
    expect(repaired.environment).toBe('room');
    expect(repaired.heldNotes).toBe('join');
    expect(repaired.custom).toEqual({ noiseGateDb: 60, requireStrike: false, strikeOnset: 0.5, minNoteLengthMs: 40 });
    expect(normalizeTranscriptionSettings({ custom: { noiseGateDb: null } }).custom.noiseGateDb).toBeNull();
  });
});
