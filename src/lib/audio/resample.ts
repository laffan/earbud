/**
 * Band-limited resampling with a Hann-windowed sinc kernel. Used to bring any
 * decoded recording to the 22.05 kHz the transcription model expects when the
 * native extractor or the browser decoder produced another rate.
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  zeroCrossings = 8,
): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLength);
  // Low-pass at the lower of the two Nyquist frequencies (a little below it).
  const cutoff = Math.min(1, ratio) * 0.95;
  const support = zeroCrossings / cutoff; // half-width in input samples
  const last = input.length - 1;

  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const start = Math.max(0, Math.ceil(center - support));
    const end = Math.min(last, Math.floor(center + support));
    let acc = 0;
    let weight = 0;
    for (let j = start; j <= end; j++) {
      const d = j - center;
      const x = d * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * d) / support);
      const k = sinc * window;
      acc += input[j] * k;
      weight += k;
    }
    out[i] = weight !== 0 ? acc / weight : 0;
  }
  return out;
}
