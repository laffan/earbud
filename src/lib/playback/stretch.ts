/**
 * Slowed playback that keeps the pitch: WSOLA (waveform-similarity
 * overlap-add), the same family of algorithm Chromium uses for
 * `preservesPitch`. Media elements did this themselves; decoded buffers
 * played through Web Audio need it done here, once per track and speed.
 *
 * The output is built from Hann-windowed input frames, 50 % overlapped. Each
 * frame is read near where the speed says it should come from, shifted by
 * up to ±`SEARCH` to the place whose waveform best continues the previous
 * frame (normalised cross-correlation), so periodic sound (sustained notes)
 * joins without beating. The search runs on a 4× decimated copy of the
 * signal, then is refined at full resolution.
 */

/** Frame length (seconds). */
const FRAME = 0.025;
/** How far a frame may move from its nominal place to line up (seconds). */
const SEARCH = 0.01;
/** Decimation of the coarse search. */
const COARSE = 4;

/**
 * Stretch `channels` (equal length, one sample rate) to play at `rate` of
 * their speed with the pitch unchanged: the output is `1 / rate` times as
 * long. The alignment is found on the channels' mix and applied to all.
 */
export function stretchChannels(channels: Float32Array[], sampleRate: number, rate: number): Float32Array[] {
  if (!(rate > 0) || Math.abs(rate - 1) < 1e-6 || channels.length === 0) return channels.map((c) => c.slice());
  const input = channels[0].length;
  const frame = Math.max(64, 2 * Math.round((FRAME * sampleRate) / 2));
  const hop = frame / 2;
  const search = Math.max(COARSE, Math.round(SEARCH * sampleRate));
  const outLength = Math.ceil(input / rate);
  const out = channels.map(() => new Float32Array(outLength + frame));
  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);

  // The signal the alignment is judged on: the channels' mix, and a decimated copy for the coarse search.
  const mix = channels.length === 1 ? channels[0] : mixDown(channels);
  const coarse = decimate(mix, COARSE);

  let previous = 0; // where the last frame was read from
  for (let k = 0, at = 0; at < outLength; k++, at += hop) {
    const nominal = Math.round(k * hop * rate);
    let from = nominal;
    if (k > 0) {
      // The input that would naturally follow the previous frame.
      const natural = previous + hop;
      const lo = Math.max(0, nominal - search);
      const hi = Math.min(Math.max(0, input - frame), nominal + search);
      if (hi > lo && natural + hop <= input) from = bestMatch(mix, coarse, natural, lo, hi, hop);
      else from = Math.min(Math.max(0, nominal), Math.max(0, input - 1));
    }
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      const n = Math.min(frame, src.length - from);
      for (let i = 0; i < n; i++) dst[at + i] += window[i] * src[from + i];
    }
    previous = from;
  }
  return out.map((c) => c.subarray(0, outLength).slice());
}

function mixDown(channels: Float32Array[]): Float32Array {
  const out = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < out.length; i++) out[i] += c[i];
  return out;
}

function decimate(signal: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(signal.length / factor));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += signal[i * factor + j];
    out[i] = sum / factor;
  }
  return out;
}

/**
 * The start in [lo, hi] whose next `length` samples best match those at
 * `target` (normalised cross-correlation): coarse, then refined.
 */
function bestMatch(signal: Float32Array, coarse: Float32Array, target: number, lo: number, hi: number, length: number): number {
  const ct = Math.floor(target / COARSE);
  const cl = Math.floor(length / COARSE);
  let best = Math.round((lo + hi) / 2);
  let bestScore = -Infinity;
  for (let s = Math.ceil(lo / COARSE); s * COARSE <= hi; s++) {
    const score = similarity(coarse, ct, s, cl);
    if (score > bestScore) {
      bestScore = score;
      best = s * COARSE;
    }
  }
  const center = best;
  bestScore = -Infinity;
  for (let s = Math.max(lo, center - COARSE); s <= Math.min(hi, center + COARSE); s++) {
    // Every second sample is plenty to choose between neighbours.
    const score = similarity(signal, target, s, length, 2);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

function similarity(signal: Float32Array, a: number, b: number, length: number, step = 1): number {
  let dot = 0;
  let energy = 0;
  const n = Math.min(length, signal.length - a, signal.length - b);
  for (let i = 0; i < n; i += step) {
    const y = signal[b + i];
    dot += signal[a + i] * y;
    energy += y * y;
  }
  return energy > 1e-12 ? dot / Math.sqrt(energy) : 0;
}
