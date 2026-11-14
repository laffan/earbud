import { describe, expect, it } from 'vitest';
import { stretchChannels } from './stretch';

const RATE = 48000;

function sine(freq: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

/** Frequency from upward zero crossings over the middle of the signal. */
function frequency(signal: Float32Array): number {
  const from = Math.floor(signal.length * 0.2);
  const to = Math.floor(signal.length * 0.8);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (signal[i - 1] < 0 && signal[i] >= 0) crossings++;
  return crossings / ((to - from) / RATE);
}

function rms(signal: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

describe('stretchChannels', () => {
  it.each([0.5, 0.75])('keeps the pitch at %s× and makes it 1/rate times as long', (rate) => {
    const input = sine(440, 2);
    const [out] = stretchChannels([input], RATE, rate);
    expect(out.length).toBe(Math.ceil(input.length / rate));
    expect(frequency(out)).toBeGreaterThan(436);
    expect(frequency(out)).toBeLessThan(444);
  });

  it('joins frames without beating: the level of a steady tone stays steady', () => {
    const [out] = stretchChannels([sine(261.63, 2)], RATE, 0.5);
    const block = Math.round(0.05 * RATE);
    const levels: number[] = [];
    for (let at = Math.round(0.1 * RATE); at + block < out.length - 0.1 * RATE; at += block) levels.push(rms(out, at, at + block));
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    expect(mean).toBeGreaterThan(0.3);
    for (const level of levels) expect(Math.abs(level - mean) / mean).toBeLessThan(0.12);
  });

  it('keeps events in time: a click at 1 s lands near 2 s at half speed', () => {
    const input = new Float32Array(2 * RATE);
    for (let i = 0; i < 200; i++) input[RATE + i] = 0.9 * Math.exp(-i / 40);
    const [out] = stretchChannels([input], RATE, 0.5);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]) > Math.abs(out[peak])) peak = i;
    expect(Math.abs(peak / RATE - 2)).toBeLessThan(0.03);
  });

  it('stretches every channel with the same alignment', () => {
    const left = sine(330, 1);
    const right = left.map((x) => -x);
    const [l, r] = stretchChannels([left, right], RATE, 0.75);
    expect(l.length).toBe(r.length);
    for (let i = 0; i < l.length; i += 997) expect(l[i]).toBeCloseTo(-r[i], 5);
  });

  it('returns a copy at normal speed', () => {
    const input = sine(440, 0.1);
    const [out] = stretchChannels([input], RATE, 1);
    expect(out).not.toBe(input);
    expect(Array.from(out)).toEqual(Array.from(input));
  });
});
