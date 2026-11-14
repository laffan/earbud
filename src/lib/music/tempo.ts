/**
 * Tempo and beat from transcribed notes.
 *
 * 1. Note starts within 50 ms are one onset (a chord); its weight grows with
 *    the notes' loudness and number.
 * 2. Candidate beat periods come from the autocorrelation of an onset-strength
 *    signal (10 ms bins), with the bar-level repeat (twice the period) as
 *    support and a preference for moderate tempos (log-normal around 100 BPM),
 *    which settles most double / half tempo ambiguities.
 * 3. Around the best candidate, tempo and phase are searched together for the
 *    beat grid the onsets fit best (onsets on beats count fully, on half
 *    beats half).
 * 4. Confidence is the share of the onset weight within 45 ms of the grid's
 *    beats or half beats, above what randomly placed notes would reach on
 *    that grid (0 = no better than chance, 1 = everything on the grid). Free,
 *    rubato playing scores low, and is reported as no tempo below
 *    `MIN_CONFIDENCE`.
 */
import type { PianoNote } from '../transcription/types';

export interface TempoEstimate {
  /** Beats per minute. */
  bpm: number;
  /** A beat (seconds), the first one at or after the playing starts (minus half a beat). */
  beat: number;
  /** How much better than chance the playing lines up with the beat grid, 0–1. */
  confidence: number;
}

const BINS_PER_SECOND = 100;
const MIN_BPM = 50;
const MAX_BPM = 200;
const PRIOR_CENTER = 100;
/** Width of the tempo preference in octaves. */
const PRIOR_WIDTH = 0.9;
/** Onsets closer than this are one (seconds). */
const CHORD_SPREAD = 0.05;
/** An onset within this of a beat or half beat counts as on the grid (seconds). */
const ON_GRID = 0.045;
const MIN_ONSETS = 8;
export const MIN_CONFIDENCE = 0.5;

interface Onset {
  t: number;
  w: number;
}

function onsets(notes: PianoNote[]): Onset[] {
  const starts = notes
    .filter((n) => Number.isFinite(n.startTime) && n.endTime > n.startTime)
    .map((n) => ({ t: n.startTime, w: (Math.max(1, n.velocity) / 127) * Math.min(1, n.confidence ?? 1) }))
    .sort((a, b) => a.t - b.t);
  const out: Onset[] = [];
  for (const s of starts) {
    const last = out[out.length - 1];
    if (last && s.t - last.t <= CHORD_SPREAD) last.w = Math.min(3, last.w + s.w);
    else out.push({ ...s });
  }
  return out;
}

/** How well onsets fit a grid of `period` with a beat at `phase`: weight near beats, half near half beats. */
function gridScore(events: Onset[], period: number, phase: number, sigma: number): number {
  let score = 0;
  for (const e of events) {
    const x = (((e.t - phase) % period) + period) % period;
    const toBeat = Math.min(x, period - x);
    const toHalf = Math.abs(x - period / 2);
    score += e.w * (Math.exp(-(toBeat * toBeat) / (2 * sigma * sigma)) + 0.5 * Math.exp(-(toHalf * toHalf) / (2 * sigma * sigma)));
  }
  return score;
}

export function detectTempo(notes: PianoNote[]): TempoEstimate | null {
  const events = onsets(notes);
  if (events.length < MIN_ONSETS) return null;
  const first = events[0].t;
  const span = events[events.length - 1].t - first;
  if (span < (60 / MAX_BPM) * 4) return null;

  // Onset strength, each onset a small bump.
  const n = Math.ceil((span + 1) * BINS_PER_SECOND);
  const signal = new Float64Array(n);
  for (const e of events) {
    const center = (e.t - first) * BINS_PER_SECOND;
    for (let k = Math.max(0, Math.floor(center - 6)); k <= Math.min(n - 1, Math.ceil(center + 6)); k++) {
      const d = (k - center) / 2;
      signal[k] += e.w * Math.exp(-0.5 * d * d);
    }
  }
  const minLag = Math.floor((60 / MAX_BPM) * BINS_PER_SECOND);
  const maxLag = Math.ceil((60 / MIN_BPM) * BINS_PER_SECOND);
  const acf = new Float64Array(2 * maxLag + 2);
  for (let lag = minLag; lag < acf.length && lag < n; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += signal[i] * signal[i + lag];
    // Fewer overlapping bins at long lags: normalize per bin.
    acf[lag] = sum / (n - lag);
  }
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * BINS_PER_SECOND) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_CENTER) / PRIOR_WIDTH) ** 2);
    const score = (acf[lag] + 0.5 * (acf[2 * lag] ?? 0)) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0 || bestScore <= 0) return null;

  // Refine tempo and phase together on the grid fit.
  const coarse = bestLag / BINS_PER_SECOND;
  let best = { period: coarse, phase: first, score: -1 };
  for (let f = 0.96; f <= 1.04 + 1e-9; f += 0.0025) {
    const period = coarse * f;
    for (let phase = 0; phase < period; phase += 0.01) {
      const score = gridScore(events, period, first + phase, 0.035);
      if (score > best.score) best = { period, phase: first + phase, score };
    }
  }
  // Finer phase at the chosen tempo.
  for (let phase = best.phase - 0.01; phase <= best.phase + 0.01; phase += 0.001) {
    const score = gridScore(events, best.period, phase, 0.035);
    if (score > best.score) best = { ...best, phase, score };
  }

  const half = best.period / 2;
  let total = 0;
  let onGrid = 0;
  for (const e of events) {
    const x = (((e.t - best.phase) % half) + half) % half;
    total += e.w;
    if (Math.min(x, half - x) <= ON_GRID) onGrid += e.w;
  }
  // Randomly placed onsets would land this often within ON_GRID of a half beat.
  const chance = Math.min(1, (2 * ON_GRID) / half);
  const confidence = total > 0 && chance < 1 ? Math.max(0, (onGrid / total - chance) / (1 - chance)) : 0;
  // The first beat at or after the playing starts (allowing a pickup of under half a beat).
  const k = Math.ceil((first - half - best.phase) / best.period);
  return {
    bpm: Math.round((60 / best.period) * 10) / 10,
    beat: best.phase + k * best.period,
    confidence,
  };
}

/** A tempo worth using: detected with enough of the playing on its grid. */
export function confidentTempo(notes: PianoNote[]): TempoEstimate | null {
  const estimate = detectTempo(notes);
  return estimate && estimate.confidence >= MIN_CONFIDENCE ? estimate : null;
}

/** The first beat at or after `time` on the grid of `bpm` through `beat` (seconds). */
export function nextBeat(time: number, bpm: number, beat: number): number {
  const period = 60 / bpm;
  return beat + Math.ceil((time - beat - 1e-6) / period) * period;
}

/** The beat nearest `time` on the grid of `bpm` through `beat` (seconds). */
export function nearestBeat(time: number, bpm: number, beat: number): number {
  const period = 60 / bpm;
  return beat + Math.round((time - beat) / period) * period;
}
