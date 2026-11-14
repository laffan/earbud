import { describe, expect, it } from 'vitest';
import { demoNotes } from '../dev/demo';
import type { PianoNote } from '../transcription/types';
import { confidentTempo, detectTempo, nearestBeat, nextBeat } from './tempo';

/** A seeded random number generator, so the tests are repeatable. */
function random(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
}

/** Chords on every beat and an eighth-note line, with timing jitter. */
function played(bpm: number, bars: number, start: number, jitter: number, seed = 1): PianoNote[] {
  const rnd = random(seed);
  const beat = 60 / bpm;
  const notes: PianoNote[] = [];
  const at = (t: number) => t + (rnd() * 2 - 1) * jitter;
  for (let b = 0; b < bars * 4; b++) {
    const t = at(start + b * beat);
    for (const pitch of b % 4 === 0 ? [36, 60, 64, 67] : [60, 64]) {
      notes.push({ pitch, startTime: t, endTime: t + beat * 0.9, velocity: b % 4 === 0 ? 90 : 60 });
    }
    for (const half of [0, 0.5]) {
      const m = at(start + (b + half) * beat);
      notes.push({ pitch: 72 + ((b * 2 + half * 2) % 5), startTime: m, endTime: m + beat * 0.45, velocity: 70 });
    }
  }
  return notes;
}

describe('tempo detection', () => {
  it('finds the tempo and the beats of steady playing', () => {
    const notes = played(92, 8, 2.1, 0.012);
    const t = detectTempo(notes)!;
    expect(t.bpm).toBeGreaterThan(91);
    expect(t.bpm).toBeLessThan(93);
    // The first beat is where the playing starts (after a 2.1 s count-in).
    expect(Math.abs(t.beat - 2.1)).toBeLessThan(0.03);
    expect(t.confidence).toBeGreaterThan(0.8);
  });

  it('copes with looser timing', () => {
    for (const [bpm, seed] of [
      [72, 2],
      [118, 3],
      [140, 4],
    ]) {
      const t = confidentTempo(played(bpm, 8, 0.5, 0.03, seed));
      expect(t, `${bpm} BPM`).not.toBeNull();
      expect(Math.abs(t!.bpm - bpm), `${bpm} BPM detected as ${t!.bpm}`).toBeLessThan(2);
    }
  });

  it('reads the demo sketch as 96 BPM, starting on its first chord', () => {
    const t = confidentTempo(demoNotes())!;
    expect(Math.abs(t.bpm - 96)).toBeLessThan(1);
    expect(Math.abs(t.beat - 0.4)).toBeLessThan(0.03);
  });

  it('gives no tempo for free playing or too few notes', () => {
    const rnd = random(7);
    const free: PianoNote[] = Array.from({ length: 60 }, () => {
      const t = rnd() * 30;
      return { pitch: 48 + Math.floor(rnd() * 30), startTime: t, endTime: t + 0.4, velocity: 40 + rnd() * 60 };
    });
    expect(confidentTempo(free)).toBeNull();
    expect(detectTempo(played(100, 1, 0, 0).slice(0, 5))).toBeNull();
  });

  it('finds beats on the grid', () => {
    expect(nextBeat(1.01, 120, 0.25)).toBeCloseTo(1.25);
    expect(nextBeat(1.25, 120, 0.25)).toBeCloseTo(1.25);
    expect(nearestBeat(1.4, 120, 0.25)).toBeCloseTo(1.25);
    expect(nearestBeat(1.6, 120, 0.25)).toBeCloseTo(1.75);
  });
});
