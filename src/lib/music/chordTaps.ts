/**
 * Chords tapped one after another (on the circle of fifths in the Reference
 * section) turned into notes for a sketch: each chord's voicing sounds from
 * its tap until the next tap; the last one until recording stops (at most
 * `MAX_LAST` seconds). Pure functions, unit tested.
 */
import type { PianoNote } from '../transcription/types';

export interface ChordTap {
  /** When it was tapped (seconds, any origin). */
  time: number;
  /** The pitches heard (MIDI), as played. */
  pitches: number[];
  /** Its symbol, e.g. "Am". */
  symbol: string;
}

/** The longest the last chord is held after its tap (seconds). */
export const MAX_LAST = 8;
/** The shortest a chord lasts (seconds), however fast the next one comes. */
export const MIN_CHORD = 0.08;

/** The taps' notes, with the first tap at time 0. `end` is when recording stopped (same clock as the taps). */
export function notesFromChordTaps(taps: ChordTap[], end: number, velocity = 80): PianoNote[] {
  const sorted = [...taps].filter((t) => Number.isFinite(t.time) && t.pitches.length > 0).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];
  const t0 = sorted[0].time;
  const notes: PianoNote[] = [];
  sorted.forEach((tap, i) => {
    const next = sorted[i + 1];
    const stop = next ? next.time : Math.min(Math.max(end, tap.time), tap.time + MAX_LAST);
    const start = tap.time - t0;
    const endTime = Math.max(start + MIN_CHORD, stop - t0);
    for (const pitch of [...new Set(tap.pitches)].sort((a, b) => a - b)) {
      notes.push({ pitch, startTime: start, endTime, velocity });
    }
  });
  return notes;
}

/** A title from the chords played, e.g. "C – G – Am – F" (repeats in a row once; long ones shortened). */
export function chordTapsTitle(taps: ChordTap[], limit = 6): string {
  const symbols: string[] = [];
  for (const tap of [...taps].sort((a, b) => a.time - b.time)) {
    if (symbols[symbols.length - 1] !== tap.symbol) symbols.push(tap.symbol);
  }
  if (symbols.length === 0) return 'Chords';
  const shown = symbols.slice(0, limit).join(' – ');
  return symbols.length > limit ? `${shown} …` : shown;
}
