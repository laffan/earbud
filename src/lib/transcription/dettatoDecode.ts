import type { PianoNote } from './types';

export const KEYS = 88;
const HOP = 0.02;

// Port of Dettato's two-voice peak decoder (Apache-2.0, KobiMusic).
// Each plane is contiguous frame-major data, indexed by frame and piano key.
export function decodeDettato(maps: Float32Array[], duration: number): PianoNote[] {
  const frames = maps[0].length / KEYS;
  const notes: PianoNote[] = [];
  for (const voice of [0, 1]) {
    const [on, frame, off] = maps.slice(voice * 3, voice * 3 + 3);
    for (let key = 0; key < KEYS; key++) {
      const at = (map: Float32Array, t: number) => map[t * KEYS + key];
      const peak = (map: Float32Array, t: number, threshold: number) =>
        at(map, t) >= threshold && (t === 0 || at(map, t) > at(map, t - 1)) &&
        (t + 1 === frames || at(map, t) >= at(map, t + 1));
      const refined = (map: Float32Array, t: number) => {
        const left = at(map, Math.max(t - 1, 0));
        const right = at(map, Math.min(t + 1, frames - 1));
        const den = 2 * (at(map, t) - Math.min(left, right));
        return t + (den <= 1e-6 ? 0 : Math.min(0.5, Math.max(-0.5, (right - left) / den)));
      };
      const candidates = [];
      for (let t = 0; t < frames; t++) {
        if (peak(on, t, voice === 0 ? 0.25 : 0.3)) candidates.push(t);
      }
      const blocked = new Set<number>();
      const starts = candidates.sort((a, b) => at(on, b) - at(on, a)).filter(t => {
        if (blocked.has(t)) return false;
        for (let i = t - 3; i <= t + 3; i++) blocked.add(i);
        return true;
      }).sort((a, b) => a - b);
      starts.forEach((start, i) => {
        const next = starts[i + 1] ?? frames;
        let end = next < frames ? refined(on, next) : frames - 0.5;
        for (let t = start + 1; t < frames && t <= next; t++) {
          if (t >= start + 2 && peak(off, t, 0.3)) { end = refined(off, t); break; }
          if (at(frame, t) < 0.4 && (t + 1 === frames || at(frame, t + 1) < 0.4)) {
            end = t - 0.5;
            break;
          }
        }
        const startTime = Math.max(0, refined(on, start) * HOP);
        const endTime = Math.min(duration, Math.max(startTime + HOP, end * HOP));
        if (endTime > startTime) {
          notes.push({ pitch: 21 + key, startTime, endTime, velocity: 80, confidence: at(on, start) });
        }
      });
    }
  }
  return notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}
