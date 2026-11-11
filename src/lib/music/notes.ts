/** Note-event helpers shared by the piano roll, chord analysis and export. */
import type { PianoNote } from '../transcription/types';

export const PIANO_MIN = 21; // A0
export const PIANO_MAX = 108; // C8

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** Lead-sheet spelling: flats for black keys except F♯. */
export const PITCH_CLASS_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const PITCH_CLASS_ASCII = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function pitchClass(pitch: number): number {
  return ((pitch % 12) + 12) % 12;
}

export function noteName(pitch: number, sharps = false): string {
  const names = sharps ? SHARP_NAMES : PITCH_CLASS_NAMES;
  return `${names[pitchClass(pitch)]}${Math.floor(pitch / 12) - 1}`;
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(pitchClass(pitch));
}

export function sortNotes(notes: PianoNote[]): PianoNote[] {
  return [...notes].sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
}

export function duration(note: PianoNote): number {
  return note.endTime - note.startTime;
}

export function notesEndTime(notes: PianoNote[]): number {
  return notes.reduce((t, n) => Math.max(t, n.endTime), 0);
}

export function pitchRange(notes: PianoNote[]): [number, number] | null {
  if (notes.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    lo = Math.min(lo, n.pitch);
    hi = Math.max(hi, n.pitch);
  }
  return [lo, hi];
}

/** Clamp a note into a valid, non-degenerate state (used by the editor). */
export function normalizeNote(note: PianoNote, maxTime = Infinity): PianoNote {
  const pitch = Math.round(Math.min(PIANO_MAX, Math.max(PIANO_MIN, note.pitch)));
  const start = Math.max(0, Math.min(note.startTime, maxTime - 0.02));
  const end = Math.min(maxTime, Math.max(start + 0.02, note.endTime));
  const velocity = Math.round(Math.min(127, Math.max(1, note.velocity)));
  const out: PianoNote = {
    pitch,
    startTime: Math.round(start * 1000) / 1000,
    endTime: Math.round(end * 1000) / 1000,
    velocity,
  };
  if (note.confidence !== undefined) out.confidence = note.confidence;
  return out;
}

/** Notes sounding at time `t`. */
export function activeAt(notes: PianoNote[], t: number): PianoNote[] {
  return notes.filter((n) => n.startTime <= t && n.endTime > t);
}
