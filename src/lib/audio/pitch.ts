/**
 * The pitch of a short sound, to play notes with a sample: which note it
 * sounds at (its root), and how far off that note it is (cents).
 *
 * YIN (de Cheveigné & Kawahara, 2002) on frames across the loudest part of
 * the sound, after its attack: the cumulative mean normalized difference
 * function, the first dip under a threshold, refined by parabolic
 * interpolation. The frames that find a period vote; the median (in cents)
 * is the pitch, and the share of frames that found one is the confidence. A
 * drum or a noise finds no steady period and gets no pitch.
 */

export interface PitchEstimate {
  /** Hz. */
  frequency: number;
  /** MIDI note, fractional (69 = A4 at 440 Hz). */
  midi: number;
  /** The nearest note. */
  note: number;
  /** How far from `note` it sounds (cents, −50…50). */
  cents: number;
  /** Share of the analysed frames that found this pitch (0–1). */
  confidence: number;
}

export interface PitchOptions {
  /** Lowest and highest pitch looked for (Hz). */
  minHz?: number;
  maxHz?: number;
  /** YIN's threshold on the normalized difference (lower = stricter). */
  threshold?: number;
  /** Below this share of voiced frames there is no pitch. */
  minConfidence?: number;
}

export function midiOf(frequency: number): number {
  return 69 + 12 * Math.log2(frequency / 440);
}

export function frequencyOf(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Halve the rate (average pairs) until it is at most `max`. */
function decimate(samples: Float32Array, sampleRate: number, max: number): { data: Float32Array; rate: number } {
  let data = samples;
  let rate = sampleRate;
  while (rate > max) {
    const out = new Float32Array(Math.floor(data.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * (data[2 * i] + data[2 * i + 1]);
    data = out;
    rate /= 2;
  }
  return { data, rate };
}

/** One frame's period by YIN (in samples, fractional), or null. */
export function yinPeriod(frame: Float32Array, minLag: number, maxLag: number, threshold: number): number | null {
  const w = frame.length - maxLag;
  if (w < 16 || maxLag <= minLag + 2) return null;
  const d = new Float32Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let sum = 0;
    for (let i = 0; i < w; i++) {
      const delta = frame[i] - frame[i + tau];
      sum += delta * delta;
    }
    d[tau] = sum;
  }
  // Cumulative mean normalized difference.
  const cmnd = new Float32Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let tau = -1;
  for (let t = Math.max(2, minLag); t <= maxLag; t++) {
    if (cmnd[t] < threshold) {
      // Walk down to the bottom of this dip.
      while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  const a = cmnd[tau - 1];
  const b = cmnd[tau];
  const c = cmnd[tau + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return tau + Math.max(-1, Math.min(1, shift));
}

/** The pitch of a sound (mono samples), or null if it has no steady one. */
export function detectPitch(samples: Float32Array, sampleRate: number, options: PitchOptions = {}): PitchEstimate | null {
  const minHz = options.minHz ?? 40;
  const maxHz = options.maxHz ?? 2000;
  const threshold = options.threshold ?? 0.15;
  const minConfidence = options.minConfidence ?? 0.4;
  const { data, rate } = decimate(samples, sampleRate, 24000);
  if (data.length < 64) return null;

  const maxLag = Math.min(Math.ceil(rate / minHz), Math.floor(data.length / 2) - 1);
  const minLag = Math.max(2, Math.floor(rate / maxHz));
  if (maxLag <= minLag + 2) return null;
  const frameLength = maxLag * 2 + Math.round(rate * 0.01);
  const hop = Math.max(1, Math.round(rate * 0.02));

  // Frames over the sound, after its attack (30 ms), that are loud enough to read.
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  if (peak < 1e-4) return null;
  const skip = Math.min(Math.round(rate * 0.03), Math.max(0, data.length - frameLength));
  const midis: number[] = [];
  let frames = 0;
  for (let start = skip; start + frameLength <= data.length && frames < 60; start += hop) {
    const frame = data.subarray(start, start + frameLength);
    let level = 0;
    for (const v of frame) level = Math.max(level, Math.abs(v));
    if (level < peak * 0.12) continue;
    frames++;
    const period = yinPeriod(frame, minLag, maxLag, threshold);
    if (period !== null && period > 0) midis.push(midiOf(rate / period));
  }
  if (frames === 0 || midis.length === 0) return null;
  midis.sort((a, b) => a - b);
  const median = midis[midis.length >> 1];
  // Frames agreeing with the median within a semitone (octave slips do not count).
  const agreeing = midis.filter((m) => Math.abs(m - median) < 1);
  const confidence = agreeing.length / frames;
  if (confidence < minConfidence) return null;
  const midi = agreeing.reduce((sum, m) => sum + m, 0) / agreeing.length;
  const note = Math.round(midi);
  return { frequency: frequencyOf(midi), midi, note, cents: Math.round((midi - note) * 100), confidence };
}
