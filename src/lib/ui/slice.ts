/**
 * Slicing a sketch on the canvas into two sketches that stand on their own.
 * Nothing is cut from a recording (recordings are never modified): both
 * halves keep the whole recording and play complementary crops of it. A
 * rhythm is cut on a bar line; the second half's pattern is turned so it
 * carries on from where the first half stops. Pure functions, unit tested.
 */
import { barSeconds, type RhythmPattern } from '../music/rhythm';
import type { Span } from './canvasGeometry';

/** The shortest part a recording is cut into (seconds; the library refuses crops under 100 ms). */
export const MIN_SLICE_PART = 0.15;

/**
 * Where a sketch can be cut, on the timeline (seconds), or null when it is too
 * short. A recording: inside its first pass (with repeats, the cut is made in the
 * part that repeats, and both halves then play once). A rhythm: on a bar line,
 * leaving at least a bar on each side.
 */
export function sliceRange(span: Span, pattern: RhythmPattern | null): { min: number; max: number } | null {
  if (pattern) {
    if (pattern.lengthBars < 2) return null;
    const bar = barSeconds(pattern);
    return { min: span.start + bar, max: span.start + (pattern.lengthBars - 1) * bar };
  }
  const min = span.start + MIN_SLICE_PART;
  const max = span.start + span.cycle - MIN_SLICE_PART;
  return max > min ? { min, max } : null;
}

/** The nearest place `time` can be cut (a rhythm: the nearest bar line), or null. */
export function snapSlice(span: Span, pattern: RhythmPattern | null, time: number): number | null {
  const range = sliceRange(span, pattern);
  if (!range) return null;
  const t = Math.min(range.max, Math.max(range.min, time));
  if (!pattern) return t;
  const bar = barSeconds(pattern);
  return span.start + Math.round((t - span.start) / bar) * bar;
}

export interface Crop {
  startMs: number | null;
  endMs: number | null;
}

/**
 * The crops of a recording cut at timeline time `at`: the first half keeps its
 * start (its count-in or crop) up to the cut, the second half plays from the cut
 * to its old end. Both sit where they were: the recording's time 0 stays put.
 */
export function sliceCrops(crop: Crop, span: Span, at: number): { first: Crop; second: Crop } {
  const into = Math.min(span.cycle, Math.max(0, at - span.start));
  const cutMs = Math.round((span.from + into) * 1000);
  return {
    first: { startMs: crop.startMs, endMs: cutMs },
    second: { startMs: cutMs, endMs: crop.endMs },
  };
}

/** `pattern` turned so that its bar `bars` (counted over its repeats) comes first. */
export function rotatePattern(pattern: RhythmPattern, bars: number): RhythmPattern {
  const perBar = pattern.stepsPerBeat * pattern.beatsPerBar;
  const shift = (((bars % pattern.bars) + pattern.bars) % pattern.bars) * perBar;
  if (shift === 0) return { ...pattern, pads: pattern.pads.map((row) => [...row]) };
  return { ...pattern, pads: pattern.pads.map((row) => [...row.slice(shift), ...row.slice(0, shift)]) };
}

/**
 * A rhythm cut after `bars` bars of what it plays: the first half plays those
 * bars, the second the rest (from where the first stops in the pattern).
 */
export function sliceRhythm(pattern: RhythmPattern, bars: number): [RhythmPattern, RhythmPattern] {
  const k = Math.min(pattern.lengthBars - 1, Math.max(1, Math.round(bars)));
  return [
    { ...pattern, pads: pattern.pads.map((row) => [...row]), lengthBars: k },
    { ...rotatePattern(pattern, k), lengthBars: pattern.lengthBars - k },
  ];
}
