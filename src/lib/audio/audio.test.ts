import { describe, expect, it } from 'vitest';
import { decodeWav, downmix, encodeWav16 } from './wav';
import { resample } from './resample';

describe('wav', () => {
  it('round-trips 16-bit mono', () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.8);
    const bytes = encodeWav16([samples], 22050);
    const pcm = decodeWav(bytes.buffer as ArrayBuffer);
    expect(pcm.sampleRate).toBe(22050);
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0]).toHaveLength(1000);
    for (let i = 0; i < 1000; i += 97) expect(pcm.channels[0][i]).toBeCloseTo(samples[i], 3);
  });

  it('decodes stereo and downmixes', () => {
    const l = new Float32Array([0.5, 0.5, 0.5]);
    const r = new Float32Array([-0.5, 0.0, 0.5]);
    const pcm = decodeWav(encodeWav16([l, r], 48000).buffer as ArrayBuffer);
    const mono = downmix(pcm.channels);
    expect(Array.from(mono).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.25, 0.5]);
  });

  it('tolerates a streaming header with a zero data size', () => {
    const bytes = encodeWav16([new Float32Array([0.1, 0.2, 0.3, 0.4])], 22050);
    new DataView(bytes.buffer).setUint32(40, 0, true);
    expect(decodeWav(bytes.buffer as ArrayBuffer).channels[0]).toHaveLength(4);
  });

  it('rejects non-wav data', () => {
    expect(() => decodeWav(new ArrayBuffer(64))).toThrow(/RIFF/);
  });
});

describe('resample', () => {
  it('preserves a low tone through 48k -> 22.05k', () => {
    const from = 48000;
    const to = 22050;
    const f = 440;
    const input = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * f * i) / from));
    const out = resample(input, from, to);
    expect(out.length).toBe(Math.floor(from * (to / from)));
    // Compare against the ideal sine away from the edges.
    let err = 0;
    for (let i = 1000; i < 20000; i++) err = Math.max(err, Math.abs(out[i] - Math.sin((2 * Math.PI * f * i) / to)));
    expect(err).toBeLessThan(0.02);
  });

  it('removes content above the new Nyquist frequency', () => {
    const from = 48000;
    const input = Float32Array.from({ length: from / 2 }, (_, i) => Math.sin((2 * Math.PI * 15000 * i) / from));
    const out = resample(input, from, 22050);
    const rms = Math.sqrt(out.slice(500, -500).reduce((s, x) => s + x * x, 0) / (out.length - 1000));
    expect(rms).toBeLessThan(0.05);
  });
});

describe('peaks', () => {
  it('finds and normalizes the loud part of a recording', async () => {
    const { computePeaks } = await import('./peaks');
    const samples = new Float32Array(1000);
    for (let i = 500; i < 600; i++) samples[i] = i % 2 ? 0.5 : -0.5;
    const peaks = computePeaks(samples, 10);
    expect(peaks).toHaveLength(10);
    expect(peaks[5]).toBe(1);
    expect(peaks[0]).toBe(0);
  });
});
