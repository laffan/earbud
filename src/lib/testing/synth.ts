/** Test helpers: synthesize piano-like tones as raw samples. */
export interface ToneSpec {
  pitch: number;
  start: number;
  end: number;
  gain?: number;
}

export function synthesize(tones: ToneSpec[], sampleRate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(sampleRate * seconds));
  for (const tone of tones) {
    const f0 = 440 * 2 ** ((tone.pitch - 69) / 12);
    const gain = tone.gain ?? 0.12;
    const from = Math.floor(tone.start * sampleRate);
    const to = Math.min(out.length, Math.floor(tone.end * sampleRate));
    for (let i = from; i < to; i++) {
      const t = (i - from) / sampleRate;
      // Fast attack, exponential decay, short release at the end.
      const release = Math.min(1, (to - i) / (0.03 * sampleRate));
      const env = Math.min(1, t * 300) * Math.exp(-t * 2.2) * release;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / (h * h);
      out[i] += gain * env * s;
    }
  }
  return out;
}
