/**
 * Rhythm sketches: what is tapped on the four pads, turned into a step
 * pattern. Each pad sounds a built-in drum (kick, snare, hat, clap) or a
 * sample from the library (`RhythmPattern.samples`).
 *
 * 1. The tempo comes from the taps (`detectTempo`, the same detector as for
 *    played notes; a weaker fit is accepted than for a recording, since taps
 *    on pads are meant to keep time). With too few taps for it, the median
 *    gap between taps, folded into 70–160 BPM, is taken as the beat.
 * 2. The beat nearest the first tap is the downbeat of bar 1. Every tap is
 *    moved to the nearest 16th note, then the tempo and downbeat are fitted
 *    to those steps (least squares) and the taps placed again, so a tempo
 *    that was slightly off does not drift over the bars.
 * 3. The pattern is as many whole 4/4 bars as the taps cover. A last bar with
 *    nothing but its downbeat is dropped: that is the pattern coming round
 *    again, which looping already plays.
 *
 * On the canvas a rhythm plays for `lengthBars` bars: the pattern repeats
 * (the last repeat cut short if it does not fit).
 */
import type { PianoNote } from '../transcription/types';
import { detectTempo } from './tempo';

export interface RhythmPattern {
  version: 1;
  /** Beats per minute. */
  bpm: number;
  /** Steps per beat (4: sixteenth notes). */
  stepsPerBeat: number;
  /** Beats per bar (4). */
  beatsPerBar: number;
  /** Length of the pattern, in bars. */
  bars: number;
  /** How long it plays on the canvas, in bars (the pattern repeats to fill it). */
  lengthBars: number;
  /** One row per pad, one value per step: 0 = silent, otherwise the hit's level (up to 1). */
  pads: number[][];
  /** Every second 16th is played this fraction of a step late (0 = straight; ⅓ ≈ triplet feel). */
  swing?: number;
  /**
   * The library sample each pad plays instead of its own sound (by sample
   * id; null or missing = the pad's own sound, also when the sample is gone).
   */
  samples?: (string | null)[];
}

/** A pad struck while recording: which one, and when (seconds, any origin). */
export interface Tap {
  pad: number;
  time: number;
}

export interface PadInfo {
  name: string;
  /** Keys that strike it (desktop). */
  keys: string[];
}

export const PADS: PadInfo[] = [
  // Labelled by number, not by drum: the sounds are a kick, a snare, a closed hi-hat and a clap (drums.ts, MIDI 36/38/42/39).
  { name: 'Beat 1', keys: ['1', 'j'] },
  { name: 'Beat 2', keys: ['2', 'k'] },
  { name: 'Beat 3', keys: ['3', 'l'] },
  { name: 'Beat 4', keys: ['4', ';'] },
];

/** The built-in sound of each pad, in words. */
export const PAD_SOUNDS = ['Kick', 'Snare', 'Hi-hat', 'Clap'];

const SAMPLE_ID = /^[0-9a-f]{32}$/;

/** The sample a pad plays (null: its own sound). */
export function padSample(p: Pick<RhythmPattern, 'samples'>, pad: number): string | null {
  const id = p.samples?.[pad];
  return typeof id === 'string' && SAMPLE_ID.test(id) ? id : null;
}

/** The pattern with pad `pad` playing `sample` (null: its own sound again). */
export function withPadSample(p: RhythmPattern, pad: number, sample: string | null): RhythmPattern {
  const samples = PADS.map((_, i) => (i === pad ? sample : padSample(p, i)));
  return { ...p, samples: samples.some((x) => x !== null) ? samples : undefined };
}

export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;
export const MIN_BPM = 40;
export const MAX_BPM = 240;
export const MAX_BARS = 16;
/** Longest a rhythm may play on the canvas, in bars. */
export const MAX_LENGTH_BARS = 512;
export const MAX_SWING = 0.5;
/** Tempo used when there is nothing to detect it from. */
export const DEFAULT_BPM = 100;
/** A tempo fit at least this good (see `TempoEstimate.confidence`) is used. */
const MIN_TAP_CONFIDENCE = 0.25;
/** Taps closer than this are one onset when measuring gaps (seconds). */
const SAME_ONSET = 0.05;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function stepsPerBar(p: Pick<RhythmPattern, 'stepsPerBeat' | 'beatsPerBar'>): number {
  return p.stepsPerBeat * p.beatsPerBar;
}

export function patternSteps(p: RhythmPattern): number {
  return p.bars * stepsPerBar(p);
}

/** Seconds per step. */
export function stepSeconds(p: Pick<RhythmPattern, 'bpm' | 'stepsPerBeat'>): number {
  return 60 / p.bpm / p.stepsPerBeat;
}

export function barSeconds(p: Pick<RhythmPattern, 'bpm' | 'beatsPerBar'>): number {
  return (60 / p.bpm) * p.beatsPerBar;
}

/** How long the pattern itself lasts (seconds). */
export function patternSeconds(p: RhythmPattern): number {
  return p.bars * barSeconds(p);
}

/** How long it plays on the canvas (seconds). */
export function playSeconds(p: RhythmPattern): number {
  return p.lengthBars * barSeconds(p);
}

export function emptyPattern(bpm = DEFAULT_BPM, bars = 1): RhythmPattern {
  const steps = bars * STEPS_PER_BEAT * BEATS_PER_BAR;
  return {
    version: 1,
    bpm,
    stepsPerBeat: STEPS_PER_BEAT,
    beatsPerBar: BEATS_PER_BAR,
    bars,
    lengthBars: bars,
    pads: PADS.map(() => new Array<number>(steps).fill(0)),
    swing: 0,
  };
}

/** A pattern read from storage, made safe to use (null if it is not one). */
export function normalizePattern(raw: unknown): RhythmPattern | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RhythmPattern>;
  const bpm = Number(r.bpm);
  const bars = Math.round(Number(r.bars));
  if (!Number.isFinite(bpm) || !Number.isFinite(bars) || bars < 1 || !Array.isArray(r.pads)) return null;
  const stepsPerBeat = Math.round(Number(r.stepsPerBeat)) || STEPS_PER_BEAT;
  const beatsPerBar = Math.round(Number(r.beatsPerBar)) || BEATS_PER_BAR;
  const steps = bars * stepsPerBeat * beatsPerBar;
  const pads = PADS.map((_, i) => {
    const row = Array.isArray(r.pads![i]) ? (r.pads![i] as unknown[]) : [];
    return Array.from({ length: steps }, (_, s) => clamp(Number(row[s]) || 0, 0, 1));
  });
  const lengthBars = Math.round(Number(r.lengthBars));
  const samples = PADS.map((_, i) => padSample(r, i));
  return {
    ...(samples.some((x) => x !== null) ? { samples } : {}),
    version: 1,
    bpm: clamp(bpm, MIN_BPM, MAX_BPM),
    stepsPerBeat,
    beatsPerBar,
    bars: clamp(bars, 1, MAX_BARS),
    lengthBars: clamp(Number.isFinite(lengthBars) && lengthBars >= 1 ? lengthBars : bars, 1, MAX_LENGTH_BARS),
    pads,
    swing: clamp(Number(r.swing) || 0, 0, MAX_SWING),
  };
}

/** One more bar, a copy of the last (as a starting point to vary). */
export function withBarAdded(p: RhythmPattern): RhythmPattern {
  if (p.bars >= MAX_BARS) return p;
  const per = stepsPerBar(p);
  const last = (p.bars - 1) * per;
  return {
    ...p,
    bars: p.bars + 1,
    lengthBars: Math.max(p.lengthBars, p.bars + 1),
    pads: p.pads.map((row) => [...row, ...row.slice(last, last + per)]),
  };
}

/** The pattern twice over (twice as many bars, the same hits), as far as the bar limit allows. */
export function doubled(p: RhythmPattern): RhythmPattern {
  if (p.bars * 2 > MAX_BARS) return p;
  return { ...p, bars: p.bars * 2, lengthBars: Math.max(p.lengthBars, p.bars * 2), pads: p.pads.map((row) => [...row, ...row]) };
}

/** Steps [from, to) of one pad silenced. */
export function withCleared(p: RhythmPattern, pad: number, from: number, to: number): RhythmPattern {
  return { ...p, pads: p.pads.map((row, i) => (i === pad ? row.map((v, s) => (s >= from && s < to ? 0 : v)) : row)) };
}

/** When step `index` (counting on from the pattern's start) sounds, swing included (seconds). */
export function stepTime(p: Pick<RhythmPattern, 'bpm' | 'stepsPerBeat' | 'swing'>, index: number): number {
  const step = stepSeconds(p);
  return index * step + (index % 2 === 1 ? (p.swing ?? 0) * step : 0);
}

/** The pattern with `bars` bars: steps added (silent) or cut at the end. It plays for at least as long. */
export function withBars(p: RhythmPattern, bars: number): RhythmPattern {
  const n = clamp(Math.round(bars), 1, MAX_BARS);
  const steps = n * stepsPerBar(p);
  return {
    ...p,
    bars: n,
    lengthBars: Math.max(p.lengthBars, n),
    pads: p.pads.map((row) => Array.from({ length: steps }, (_, s) => row[s] ?? 0)),
  };
}

export function withStep(p: RhythmPattern, pad: number, step: number, level: number): RhythmPattern {
  return { ...p, pads: p.pads.map((row, i) => (i === pad ? row.map((v, s) => (s === step ? level : v)) : row)) };
}

export interface RhythmHit {
  pad: number;
  /** Seconds from the rhythm's start. */
  time: number;
  level: number;
}

/** Every hit as it plays on the canvas: the pattern repeated over `lengthBars` bars. */
export function rhythmHits(p: RhythmPattern, lengthBars = p.lengthBars): RhythmHit[] {
  const total = lengthBars * stepsPerBar(p);
  const cycle = patternSteps(p);
  const hits: RhythmHit[] = [];
  for (let k = 0; k < total; k++) {
    const s = k % cycle;
    for (let pad = 0; pad < p.pads.length; pad++) {
      const level = p.pads[pad][s] ?? 0;
      if (level > 0) hits.push({ pad, time: stepTime(p, k), level });
    }
  }
  return hits;
}

export interface RhythmFromTaps {
  pattern: RhythmPattern;
  /** Where step 0 lies, in the taps' time (seconds). */
  origin: number;
  /** The tempo came from the tempo detector (not from the gaps between taps). */
  detected: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A beat period from the gaps between onsets, folded into a moderate tempo. */
function periodFromGaps(times: number[]): number | null {
  const onsets: number[] = [];
  for (const t of times) if (onsets.length === 0 || t - onsets[onsets.length - 1] > SAME_ONSET) onsets.push(t);
  if (onsets.length < 2) return null;
  const gaps = onsets.slice(1).map((t, i) => t - onsets[i]);
  let period = median(gaps);
  if (!(period > 0)) return null;
  while (60 / period > 160) period *= 2;
  while (60 / period < 70) period /= 2;
  return period;
}

/** Least-squares line through (step, time): seconds per step and where step 0 lies. */
function fitGrid(points: { step: number; time: number }[]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const { step, time } of points) {
    sx += step;
    sy += time;
    sxx += step * step;
    sxy += step * time;
  }
  const d = n * sxx - sx * sx;
  if (d <= 0) return null;
  const slope = (n * sxy - sx * sy) / d;
  return { slope, intercept: (sy - slope * sx) / n };
}

/** Turn taps into a pattern: tempo, a 16th-note grid from the first tap's beat, whole bars. */
export function patternFromTaps(taps: Tap[]): RhythmFromTaps | null {
  const sorted = taps.filter((t) => Number.isFinite(t.time) && t.pad >= 0 && t.pad < PADS.length).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return null;
  const t0 = sorted[0].time;
  const times = sorted.map((t) => t.time - t0);

  // 1. Tempo, and a beat on its grid.
  const notes: PianoNote[] = sorted.map((t, i) => ({
    pitch: 36 + t.pad,
    startTime: times[i],
    endTime: times[i] + 0.1,
    velocity: 100,
    confidence: 1,
  }));
  const estimate = detectTempo(notes);
  let detected = false;
  let period: number;
  let beat = 0;
  if (estimate && estimate.confidence >= MIN_TAP_CONFIDENCE) {
    period = 60 / estimate.bpm;
    beat = estimate.beat;
    detected = true;
  } else {
    period = periodFromGaps(times) ?? 60 / DEFAULT_BPM;
  }

  // 2. The beat nearest the first tap is bar 1's downbeat; taps go to the nearest 16th.
  let origin = beat + Math.round((0 - beat) / period) * period;
  let step = period / STEPS_PER_BEAT;
  const place = () => times.map((t) => Math.max(0, Math.round((t - origin) / step)));
  let steps = place();
  const fit = fitGrid(steps.map((s, i) => ({ step: s, time: times[i] })));
  if (fit && Math.abs(fit.slope / step - 1) < 0.08) {
    step = fit.slope;
    origin = fit.intercept;
    steps = place();
  }
  const bpm = clamp(Math.round((60 / (step * STEPS_PER_BEAT)) * 10) / 10, MIN_BPM, MAX_BPM);

  // 3. Whole bars; a lone downbeat at the end is the pattern coming round again.
  const perBar = STEPS_PER_BEAT * BEATS_PER_BAR;
  let bars = Math.max(1, Math.ceil((Math.max(...steps) + 1) / perBar));
  if (bars > 1 && steps.every((s) => s < (bars - 1) * perBar || s === (bars - 1) * perBar)) bars--;
  bars = Math.min(bars, MAX_BARS);

  const pattern = emptyPattern(bpm, bars);
  steps.forEach((s, i) => {
    if (s < bars * perBar) pattern.pads[sorted[i].pad][s] = 1;
  });
  return { pattern, origin: t0 + origin, detected };
}
