import { describe, expect, it } from 'vitest';
import { decodeWav } from '../audio/wav';
import { frequencyOf } from '../audio/pitch';
import { cutMono, cutSample } from './extract';
import { impulse, needsWebAudio } from './render';
import {
  DEFAULT_SAMPLE_SETTINGS,
  envelopeAt,
  normalizeSampleSettings,
  playedRoot,
  rateFor,
  sampleTitle,
  shapeSample,
  trimSpan,
} from './settings';

const RATE = 8000;
const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => (i + 1) / n);

describe('sample settings', () => {
  it('reads stored settings defensively', () => {
    expect(normalizeSampleSettings(null)).toEqual(DEFAULT_SAMPLE_SETTINGS);
    const s = normalizeSampleSettings({ gainDb: 99, reverb: -1, pitch: 3.6, start: -2, end: 0, lowpassHz: 'x', rootPitch: 200, rootSource: 'magic', reverse: 'yes' });
    expect(s.gainDb).toBe(12);
    expect(s.reverb).toBe(0);
    expect(s.pitch).toBe(4);
    expect(s.start).toBe(0);
    expect(s.end).toBeCloseTo(0.01);
    expect(s.lowpassHz).toBeNull();
    expect(s.rootPitch).toBe(108);
    expect(s.rootSource).toBeNull();
    expect(s.reverse).toBe(false);
  });

  it('plays notes from its root, tuning and transposition', () => {
    const s = normalizeSampleSettings({ rootPitch: 57, fineCents: -20, pitch: 2 });
    expect(playedRoot(s)).toBeCloseTo(58.8);
    expect(playedRoot(DEFAULT_SAMPLE_SETTINGS)).toBe(60);
    expect(rateFor(60, 72)).toBeCloseTo(2);
    expect(rateFor(60, 53)).toBeCloseTo(2 ** (-7 / 12));
  });

  it('trims inside the sound', () => {
    expect(trimSpan(normalizeSampleSettings({ start: 0.2, end: 0.6 }), 1)).toEqual({ from: 0.2, to: 0.6 });
    expect(trimSpan(normalizeSampleSettings({ start: 3 }), 1).from).toBeLessThan(1);
    expect(trimSpan(DEFAULT_SAMPLE_SETTINGS, 2)).toEqual({ from: 0, to: 2 });
  });

  it('shapes the envelope: attack, decay and release', () => {
    const env = { attack: 0.1, decay: 0, release: 0.2 };
    expect(envelopeAt(0, 1, env)).toBe(0);
    expect(envelopeAt(0.05, 1, env)).toBeCloseTo(0.5);
    expect(envelopeAt(0.5, 1, env)).toBe(1);
    expect(envelopeAt(0.9, 1, env)).toBeCloseTo(0.5);
    expect(envelopeAt(1, 1, env)).toBe(0);
    const decaying = { attack: 0, decay: 1, release: 0 };
    expect(envelopeAt(1, 2, decaying)).toBeCloseTo(Math.exp(-4));
    expect(envelopeAt(0.5, 2, decaying)).toBeGreaterThan(envelopeAt(1, 2, decaying));
  });

  it('trims, reverses, normalizes and sets the level in JS', () => {
    const sound = ramp(RATE); // one second rising to 1
    const trimmed = shapeSample(sound, RATE, normalizeSampleSettings({ start: 0.5, end: 0.75, attack: 0, release: 0 }));
    expect(trimmed.length).toBe(RATE / 4);
    expect(trimmed[0]).toBeCloseTo(0.5, 3);
    const reversed = shapeSample(sound, RATE, normalizeSampleSettings({ reverse: true, attack: 0, release: 0 }));
    expect(reversed[0]).toBeCloseTo(1, 3);
    const quiet = Float32Array.from(sound, (v) => v * 0.1);
    const normalized = shapeSample(quiet, RATE, normalizeSampleSettings({ normalize: true, attack: 0, release: 0 }));
    expect(Math.max(...normalized)).toBeCloseTo(0.89, 2);
    const louder = shapeSample(quiet, RATE, normalizeSampleSettings({ gainDb: 6, attack: 0, release: 0 }));
    expect(louder[RATE - 1] / quiet[RATE - 1]).toBeCloseTo(10 ** (6 / 20), 3);
  });

  it('needs Web Audio only for transposition, another rate, filters or reverb', () => {
    expect(needsWebAudio(DEFAULT_SAMPLE_SETTINGS, 44100, 44100)).toBe(false);
    expect(needsWebAudio(DEFAULT_SAMPLE_SETTINGS, 44100, 48000)).toBe(true);
    expect(needsWebAudio(normalizeSampleSettings({ pitch: 1 }), 44100, 44100)).toBe(true);
    expect(needsWebAudio(normalizeSampleSettings({ reverb: 0.3 }), 44100, 44100)).toBe(true);
    expect(needsWebAudio(normalizeSampleSettings({ lowpassHz: 2000 }), 44100, 44100)).toBe(true);
  });

  it('makes the same reverb impulse every time, dying away', () => {
    const a = impulse(RATE, 1);
    expect(a.length).toBe(RATE);
    expect(impulse(RATE, 1)).toEqual(a);
    const energy = (from: number, to: number) => a.slice(from, to).reduce((sum, v) => sum + v * v, 0);
    expect(energy(0, RATE / 4)).toBeGreaterThan(energy((3 * RATE) / 4, RATE) * 20);
  });

  it('titles samples after the sketch and the time', () => {
    expect(sampleTitle('Morning idea', 72.34)).toBe('Morning idea 1:12.3');
    expect(sampleTitle('  ', 3)).toBe('Sample 0:03.0');
  });
});

describe('cutting a sample from a recording', () => {
  it('cuts the passage, mixed to mono', () => {
    const left = ramp(RATE);
    const right = Float32Array.from(left, (v) => -v);
    expect(cutMono({ sampleRate: RATE, channels: [left] }, 0.25, 0.5).length).toBe(RATE / 4);
    const mono = cutMono({ sampleRate: RATE, channels: [left, right] }, 0, 1);
    expect(Math.max(...mono.map(Math.abs))).toBe(0);
  });

  it('writes a WAV with the root note found in it', () => {
    const rate = 22050;
    const tone = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * frequencyOf(64) * i) / rate) + 0.2 * Math.sin((4 * Math.PI * frequencyOf(64) * i) / rate));
    const silence = new Float32Array(rate);
    const sound = { sampleRate: rate, channels: [Float32Array.from([...silence, ...tone])] };
    const cut = cutSample(sound, 1, 1.8);
    expect(cut.durationMs).toBe(800);
    expect(cut.settings.rootPitch).toBe(64);
    expect(cut.settings.rootSource).toBe('detected');
    const back = decodeWav(cut.wav.buffer as ArrayBuffer);
    expect(back.sampleRate).toBe(rate);
    expect(back.channels[0].length).toBe(Math.round(0.8 * rate));
    // A drum hit (noise) has no root.
    const noise = Float32Array.from({ length: rate / 2 }, (_, i) => Math.sin(i * 12.9898) * 43758.5453 % 1);
    expect(cutSample({ sampleRate: rate, channels: [noise] }, 0, 0.5).settings.rootPitch).toBeNull();
    expect(() => cutSample(sound, 0.5, 0.5)).toThrow();
  });
});
