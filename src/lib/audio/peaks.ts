/** Waveform overview data computed from the analysis audio. */
import { fileUrl } from '../platform/tauri';
import { decodeWav, downmix } from './wav';

export interface Peaks {
  /** Normalized peak amplitude per bucket, 0–1 (an overview of the whole take). */
  values: Float32Array;
  /** The same at `DETAIL_RATE` buckets per second, for zoomed-in views. */
  detail: Float32Array;
  duration: number;
}

/** Buckets per second of `Peaks.detail`. */
export const DETAIL_RATE = 150;

/** Peak (max |sample|) per bucket, normalized so the loudest bucket is 1. */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const count = Math.max(1, Math.min(buckets, samples.length));
  const out = new Float32Array(count);
  const per = samples.length / count;
  let loudest = 0;
  for (let b = 0; b < count; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(samples.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    out[b] = peak;
    if (peak > loudest) loudest = peak;
  }
  if (loudest > 1e-4) for (let b = 0; b < count; b++) out[b] /= loudest;
  return out;
}

const cache = new Map<string, Promise<Peaks>>();

/** Load (and cache) peaks for a WAV file. */
export function loadPeaks(path: string, buckets = 2000): Promise<Peaks> {
  let pending = cache.get(path);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(fileUrl(path));
      if (!response.ok) throw new Error(`Could not read audio (${response.status})`);
      const pcm = decodeWav(await response.arrayBuffer());
      const mono = downmix(pcm.channels);
      const duration = mono.length / pcm.sampleRate;
      return {
        values: computePeaks(mono, buckets),
        detail: computePeaks(mono, Math.max(1, Math.round(duration * DETAIL_RATE))),
        duration,
      };
    })();
    pending.catch(() => cache.delete(path));
    cache.set(path, pending);
  }
  return pending;
}
