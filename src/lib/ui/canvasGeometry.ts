/**
 * Geometry of a notebook's canvas: the horizontal axis is the notebook's
 * timeline (seconds, `pps` pixels per second), the vertical one free canvas
 * pixels. Pure functions, unit tested.
 */
import type { Sketch } from '../library/types';
import { normalizePattern, playSeconds } from '../music/rhythm';

/** Height of a sketch on the canvas: its title and waveform (px). */
export const TILE_H = 66;
/** Height of the time ruler along the top of the canvas (px). */
export const RULER_H = 26;
export const MIN_PPS = 2;
export const MAX_PPS = 400;
export const DEFAULT_PPS = 28;
/** How far past time 0, and above the top, the view may scroll (px). */
export const EDGE_PX = 48;

export interface CanvasView {
  /** Timeline position at the left edge (seconds). */
  scrollX: number;
  /** Canvas position at the top edge, under the ruler (px). */
  scrollY: number;
  /** Pixels per second. */
  pps: number;
}

/** Where a sketch plays on the timeline. */
export interface Span {
  /** Timeline position of its recording's time 0 (seconds). */
  origin: number;
  /** The part of the recording that plays, in its own seconds: after the count-in, inside the crop. */
  from: number;
  to: number;
  /** Where it plays on the timeline (the part, repeated). */
  start: number;
  end: number;
  /** Length of one pass of the part (seconds), and how many play in a row (a rhythm: 1, it repeats by bars). */
  cycle: number;
  repeats: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/**
 * A sketch's span. A recording plays from its downbeat (the end of the
 * count-in) or its crop start, to its crop end or its end, `canvasRepeats`
 * times in a row; a rhythm for its pattern's length on the canvas. `length`
 * is the recording's real length once it is decoded.
 */
export function sketchSpan(sketch: Sketch, length?: number): Span {
  const origin = sketch.canvasXMs / 1000;
  if (sketch.kind === 'rhythm') {
    const pattern = normalizePattern(sketch.rhythm);
    const seconds = pattern ? playSeconds(pattern) : Math.max(0.5, (sketch.durationMs ?? 1000) / 1000);
    return { origin, from: 0, to: seconds, start: origin, end: origin + seconds, cycle: seconds, repeats: 1 };
  }
  const repeats = Math.max(1, Math.round(sketch.canvasRepeats ?? 1));
  const total = length ?? (sketch.durationMs ?? 0) / 1000;
  if (!(total > 0.05)) return { origin, from: 0, to: 1, start: origin, end: origin + repeats, cycle: 1, repeats };
  const head = sketch.cropStartMs !== null ? sketch.cropStartMs / 1000 : (sketch.countInMs ?? 0) / 1000;
  let from = clamp(head, 0, total);
  let to = clamp(sketch.cropEndMs !== null ? sketch.cropEndMs / 1000 : total, 0, total);
  if (to - from < 0.05) {
    from = 0;
    to = total;
  }
  return { origin, from, to, start: origin + from, end: origin + from + (to - from) * repeats, cycle: to - from, repeats };
}

/** Keep a view within bounds: zoom limits, and not far past time 0 or above the top. */
export function clampView(view: CanvasView): CanvasView {
  const pps = clamp(view.pps, MIN_PPS, MAX_PPS);
  return {
    pps,
    scrollX: Math.max(-EDGE_PX / pps, view.scrollX),
    scrollY: Math.max(-EDGE_PX, view.scrollY),
  };
}

/** Zoom by `factor` keeping the time under `x` (px from the left edge) where it is. */
export function zoomAround(view: CanvasView, factor: number, x: number): CanvasView {
  const time = view.scrollX + x / view.pps;
  const pps = clamp(view.pps * factor, MIN_PPS, MAX_PPS);
  return clampView({ ...view, pps, scrollX: time - x / pps });
}

/** A view showing every item (spans with their tops), with a margin. */
export function fitView(items: { start: number; end: number; y: number }[], width: number, height: number): CanvasView {
  if (items.length === 0 || width <= 0) return clampView({ scrollX: -1, scrollY: -24, pps: DEFAULT_PPS });
  const margin = Math.min(36, width * 0.08);
  const start = Math.min(...items.map((i) => i.start));
  const end = Math.max(...items.map((i) => i.end));
  const top = Math.min(...items.map((i) => i.y));
  const pps = clamp((width - 2 * margin) / Math.max(0.5, end - start), MIN_PPS, MAX_PPS);
  const bottom = Math.max(...items.map((i) => i.y + TILE_H));
  // Vertically: from the top item, unless everything fits with room to spare.
  const scrollY = bottom - top + 48 < height ? top - Math.max(24, (height - (bottom - top)) / 3) : top - 24;
  return clampView({ pps, scrollX: start - margin / pps, scrollY });
}

/** Seconds between labelled ticks on the ruler, so labels are at least `minPx` apart. */
export function rulerStep(pps: number, minPx = 64): number {
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  return steps.find((s) => s * pps >= minPx) ?? 1800;
}
