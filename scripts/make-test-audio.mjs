// Writes a WAV of synthesized two-handed piano chords (C, Am, F, G7) used by
// the browser smoke test as a fake microphone. Usage:
//   node scripts/make-test-audio.mjs out.wav
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'test-chords.wav';
const rate = 44100;
const seconds = 7;
const samples = new Float32Array(rate * seconds);
const chords = [
  [36, 60, 64, 67],
  [45, 57, 60, 64],
  [41, 57, 60, 65],
  [43, 55, 59, 62, 65],
];
chords.forEach((pitches, i) => {
  const start = 0.8 + i * 1.4;
  const end = start + 1.25;
  for (const pitch of pitches) {
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    for (let n = Math.floor(start * rate); n < Math.min(samples.length, end * rate); n++) {
      const t = n / rate - start;
      const release = Math.min(1, (end - n / rate) / 0.03);
      const env = Math.min(1, t * 300) * Math.exp(-t * 2.2) * release;
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / (h * h);
      samples[n] += 0.1 * env * s;
    }
  }
});
const data = Buffer.alloc(44 + samples.length * 2);
data.write('RIFF', 0);
data.writeUInt32LE(36 + samples.length * 2, 4);
data.write('WAVE', 8);
data.write('fmt ', 12);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(1, 22);
data.writeUInt32LE(rate, 24);
data.writeUInt32LE(rate * 2, 28);
data.writeUInt16LE(2, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(samples.length * 2, 40);
samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2));
writeFileSync(out, data);
console.log(`wrote ${out}`);
