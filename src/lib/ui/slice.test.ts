import { describe, expect, it } from 'vitest';
import { emptyPattern, rhythmHits, type RhythmPattern } from '../music/rhythm';
import type { Span } from './canvasGeometry';
import { MIN_SLICE_PART, rotatePattern, sliceCrops, sliceRange, sliceRhythm, snapSlice } from './slice';

/** A recording placed at 3 s on the timeline, its count-in ending 2 s in, playing 2–9 s of itself. */
const recording: Span = { origin: 3, from: 2, to: 9, start: 5, end: 12, cycle: 7, repeats: 1 };

/** Two bars at 120 BPM (a bar is 2 s), a different hit in each bar, playing six bars from 10 s. */
function twoBars(): RhythmPattern {
  const p = emptyPattern(120, 2);
  p.pads[0][0] = 1; // bar 1, kick on the downbeat
  p.pads[1][16] = 1; // bar 2, snare on the downbeat
  return { ...p, lengthBars: 6 };
}
const rhythmSpan: Span = { origin: 10, from: 0, to: 12, start: 10, end: 22, cycle: 12, repeats: 1 };

describe('slicing a recording', () => {
  it('cuts anywhere in what plays, leaving a little on each side', () => {
    expect(sliceRange(recording, null)).toEqual({ min: 5 + MIN_SLICE_PART, max: 12 - MIN_SLICE_PART });
    expect(snapSlice(recording, null, 8.25)).toBe(8.25);
    expect(snapSlice(recording, null, 1)).toBe(5 + MIN_SLICE_PART);
    expect(sliceRange({ ...recording, end: 5.2, cycle: 0.2 }, null)).toBeNull();
  });

  it('cuts a repeated recording inside its first pass', () => {
    const repeated = { ...recording, end: 26, repeats: 3 };
    expect(sliceRange(repeated, null)!.max).toBeCloseTo(12 - MIN_SLICE_PART);
  });

  it('gives the halves complementary crops of the same recording', () => {
    // The cut at 8 s on the timeline is 3 s into what plays, 5 s into the recording.
    expect(sliceCrops({ startMs: null, endMs: null }, recording, 8)).toEqual({
      first: { startMs: null, endMs: 5000 },
      second: { startMs: 5000, endMs: null },
    });
    // An existing crop is kept on the outer ends.
    const cropped: Span = { origin: 3, from: 2.5, to: 7, start: 5.5, end: 10, cycle: 4.5, repeats: 1 };
    expect(sliceCrops({ startMs: 2500, endMs: 7000 }, cropped, 6.5)).toEqual({
      first: { startMs: 2500, endMs: 3500 },
      second: { startMs: 3500, endMs: 7000 },
    });
  });
});

describe('slicing a rhythm', () => {
  it('cuts on a bar line, leaving at least a bar on each side', () => {
    const p = twoBars();
    expect(sliceRange(rhythmSpan, p)).toEqual({ min: 12, max: 20 });
    expect(snapSlice(rhythmSpan, p, 14.9)).toBe(14);
    expect(snapSlice(rhythmSpan, p, 15.1)).toBe(16);
    expect(snapSlice(rhythmSpan, p, 30)).toBe(20);
    expect(sliceRange(rhythmSpan, { ...p, lengthBars: 1 })).toBeNull();
  });

  it('turns a pattern by whole bars', () => {
    const p = twoBars();
    const turned = rotatePattern(p, 1);
    expect(turned.pads[1][0]).toBe(1);
    expect(turned.pads[0][16]).toBe(1);
    expect(rotatePattern(p, 2).pads).toEqual(p.pads);
    expect(p.pads[0][0]).toBe(1); // the original is left as it was
  });

  it('plays the same hits in its two halves as it did whole', () => {
    const p = twoBars();
    const [first, second] = sliceRhythm(p, 3);
    expect([first.lengthBars, second.lengthBars]).toEqual([3, 3]);
    const bar = 2;
    const whole = rhythmHits(p).map((h) => [h.pad, +h.time.toFixed(3)]);
    const halves = [
      ...rhythmHits(first).map((h) => [h.pad, +h.time.toFixed(3)]),
      ...rhythmHits(second).map((h) => [h.pad, +(h.time + 3 * bar).toFixed(3)]),
    ];
    expect(halves).toEqual(whole);
  });
});
