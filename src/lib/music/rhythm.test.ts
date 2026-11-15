import { describe, expect, it } from 'vitest';
import { mixRhythm, RHYTHM_TAIL } from './drums';
import {
  emptyPattern,
  normalizePattern,
  patternFromTaps,
  playSeconds,
  rhythmHits,
  withBars,
  withStep,
  type Tap,
} from './rhythm';

/** Deterministic jitter in ±`amount` seconds. */
function jitter(seed: number, amount: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * amount;
}

/** A rock beat: kick on 1 and 3, snare on 2 and 4, hat on every eighth; then a closing kick. */
function rockBeat(bpm: number, bars: number, start = 3.2, spread = 0.012): Tap[] {
  const beat = 60 / bpm;
  const taps: Tap[] = [];
  let n = 0;
  for (let b = 0; b < bars * 4; b++) {
    const t = start + b * beat;
    if (b % 2 === 0) taps.push({ pad: 0, time: t + jitter(n++, spread) });
    else taps.push({ pad: 1, time: t + jitter(n++, spread) });
    taps.push({ pad: 2, time: t + jitter(n++, spread) });
    taps.push({ pad: 2, time: t + beat / 2 + jitter(n++, spread) });
  }
  taps.push({ pad: 0, time: start + bars * 4 * beat + jitter(n++, spread) });
  return taps;
}

const on = (row: number[]) => row.flatMap((v, i) => (v > 0 ? [i] : []));

describe('patternFromTaps', () => {
  it('finds the tempo and puts a played beat on a 16th-note grid', () => {
    const result = patternFromTaps(rockBeat(120, 2))!;
    expect(result.detected).toBe(true);
    const p = result.pattern;
    expect(p.bpm).toBeGreaterThan(118);
    expect(p.bpm).toBeLessThan(122);
    // The closing kick is the pattern coming round again: two bars, not three.
    expect(p.bars).toBe(2);
    expect(p.lengthBars).toBe(2);
    expect(on(p.pads[0])).toEqual([0, 8, 16, 24]);
    expect(on(p.pads[1])).toEqual([4, 12, 20, 28]);
    expect(on(p.pads[2])).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);
    // Step 0 is at the first tap.
    expect(Math.abs(result.origin - 3.2)).toBeLessThan(0.02);
  });

  it('follows a tempo the detector only gets close to', () => {
    const p = patternFromTaps(rockBeat(97, 4, 0.5, 0.015))!.pattern;
    expect(Math.abs(p.bpm - 97)).toBeLessThan(1);
    expect(p.bars).toBe(4);
    expect(on(p.pads[1])).toEqual([4, 12, 20, 28, 36, 44, 52, 60]);
  });

  it('falls back to the gaps between taps when there are too few to detect a tempo', () => {
    const beat = 60 / 90;
    const p = patternFromTaps([0, 1, 2].map((i) => ({ pad: 0, time: 1 + i * beat })))!;
    expect(p.detected).toBe(false);
    expect(Math.abs(p.pattern.bpm - 90)).toBeLessThan(0.5);
    expect(p.pattern.bars).toBe(1);
    expect(on(p.pattern.pads[0])).toEqual([0, 4, 8]);
  });

  it('makes one bar of a single tap', () => {
    const p = patternFromTaps([{ pad: 2, time: 7 }])!.pattern;
    expect(p.bars).toBe(1);
    expect(on(p.pads[2])).toEqual([0]);
    expect(on(p.pads[0])).toEqual([]);
  });

  it('has nothing to make of no taps', () => {
    expect(patternFromTaps([])).toBeNull();
  });
});

describe('patterns on the canvas', () => {
  it('repeats the pattern over its length, cutting the last repeat short', () => {
    let p = withStep(withStep(emptyPattern(120, 2), 0, 0, 1), 1, 16, 1);
    p = { ...p, lengthBars: 3 };
    const hits = rhythmHits(p);
    // Bar 1: kick; bar 2: snare; bar 3 (the pattern again): kick.
    expect(hits.map((h) => [h.pad, h.time])).toEqual([
      [0, 0],
      [1, 2],
      [0, 4],
    ]);
    expect(playSeconds(p)).toBe(6);
  });

  it('mixes each pad at its hits', () => {
    const p = { ...withStep(withStep(emptyPattern(120, 1), 0, 0, 1), 2, 4, 0.5), lengthBars: 2 };
    const rate = 100;
    const pads = [new Float32Array([1]), new Float32Array([1]), new Float32Array([1])];
    const out = mixRhythm(p, pads, rate);
    expect(out.length).toBe(Math.ceil((4 + RHYTHM_TAIL) * rate));
    // Kick at 0 s and 2 s (full level × kit gain), hat at 0.5 s and 2.5 s at half that.
    const nonZero = [...out].flatMap((v, i) => (v !== 0 ? [[i, Math.round(v * 100) / 100]] : []));
    expect(nonZero).toEqual([
      [0, 0.7],
      [50, 0.35],
      [200, 0.7],
      [250, 0.35],
    ]);
  });

  it('changes length in whole bars and keeps playing at least as long', () => {
    const p = withStep(emptyPattern(100, 1), 0, 3, 1);
    const longer = withBars(p, 2);
    expect(longer.pads[0].length).toBe(32);
    expect(longer.pads[0][3]).toBe(1);
    expect(longer.lengthBars).toBe(2);
    const shorter = withBars({ ...longer, lengthBars: 6 }, 1);
    expect(shorter.pads[0].length).toBe(16);
    expect(shorter.lengthBars).toBe(6);
  });

  it('reads stored patterns defensively', () => {
    expect(normalizePattern(null)).toBeNull();
    expect(normalizePattern({ bpm: 'fast' })).toBeNull();
    const p = normalizePattern({ bpm: 1000, bars: 1, pads: [[1, 2, -1]], lengthBars: 0 })!;
    expect(p.bpm).toBe(240);
    expect(p.pads.length).toBe(3);
    expect(p.pads[0].slice(0, 4)).toEqual([1, 1, 0, 0]);
    expect(p.pads[2].length).toBe(16);
    expect(p.lengthBars).toBe(1);
  });
});
