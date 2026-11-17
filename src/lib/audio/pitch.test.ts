import { describe, expect, it } from 'vitest';
import { detectPitch, frequencyOf, midiOf } from './pitch';

const RATE = 44100;

/** A plucked, harmonic tone: partials 1–5 falling off, decaying, with a click of noise at the start. */
function pluck(frequency: number, seconds = 1, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let seed = 7;
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    let v = 0;
    for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * frequency * k * t) / k ** 1.3;
    seed = (seed * 16807) % 2147483647;
    const noise = t < 0.01 ? ((seed / 2147483647) * 2 - 1) * 0.5 : 0;
    out[i] = (v * 0.4 + noise) * Math.exp(-2.5 * t);
  }
  return out;
}

describe('detectPitch', () => {
  it('finds the note of harmonic tones across the range', () => {
    for (const midi of [40, 45, 57, 60, 69, 76, 84]) {
      const found = detectPitch(pluck(frequencyOf(midi)), RATE);
      expect(found, `midi ${midi}`).not.toBeNull();
      expect(found!.note).toBe(midi);
      expect(Math.abs(found!.cents)).toBeLessThanOrEqual(3);
      expect(found!.confidence).toBeGreaterThan(0.8);
    }
  });

  it('reports how far off the note a sound is', () => {
    const found = detectPitch(pluck(frequencyOf(62.3)), RATE)!;
    expect(found.note).toBe(62);
    expect(found.cents).toBeGreaterThanOrEqual(26);
    expect(found.cents).toBeLessThanOrEqual(34);
  });

  it('works at other sample rates', () => {
    const found = detectPitch(pluck(frequencyOf(55), 1, 22050), 22050)!;
    expect(found.note).toBe(55);
  });

  it('finds no pitch in noise or silence', () => {
    const noise = new Float32Array(RATE);
    let seed = 3;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 16807) % 2147483647;
      noise[i] = (seed / 2147483647) * 2 - 1;
    }
    expect(detectPitch(noise, RATE)).toBeNull();
    expect(detectPitch(new Float32Array(RATE), RATE)).toBeNull();
  });

  it('converts between Hz and MIDI', () => {
    expect(midiOf(440)).toBeCloseTo(69, 6);
    expect(frequencyOf(60)).toBeCloseTo(261.626, 2);
  });
});
