/**
 * Editing several notes at once: which notes a drag rectangle covers, moving
 * or resizing a group as one, and joining fragments of the same pitch.
 */
import type { PianoNote } from '../transcription/types';
import { normalizeNote, PIANO_MAX, PIANO_MIN } from './notes';

/** A rectangle on the piano roll: a time span and an inclusive pitch range. */
export interface NoteBox {
  startTime: number;
  endTime: number;
  pitchLow: number;
  pitchHigh: number;
}

/** Indices of the notes that touch the box. */
export function notesInBox(notes: readonly PianoNote[], box: NoteBox): number[] {
  const out: number[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.pitch < box.pitchLow || n.pitch > box.pitchHigh) continue;
    if (n.startTime < box.endTime && n.endTime > box.startTime) out.push(i);
  }
  return out;
}

/** Sorted union of two index lists. */
export function mergeSelection(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

export interface NoteShift {
  /** Move in time (seconds). */
  time?: number;
  /** Move in pitch (semitones). */
  pitch?: number;
  /** Move only the start (seconds). */
  start?: number;
  /** Move only the end (seconds). */
  end?: number;
}

/** Shortest note the editor leaves behind when resizing (seconds). */
const MIN_LENGTH = 0.03;

/**
 * Apply one edit to a group of notes. Moves are rigid: the group stops as a
 * whole at the start of the take and at the ends of the keyboard, so the
 * notes keep their distances to each other. Resizing changes every note by
 * the same amount, each down to a minimum length.
 */
export function shiftNotes(group: readonly PianoNote[], shift: NoteShift, maxTime = Infinity): PianoNote[] {
  if (group.length === 0) return [];
  let earliest = Infinity;
  let latest = -Infinity;
  let lowest = Infinity;
  let highest = -Infinity;
  for (const n of group) {
    earliest = Math.min(earliest, n.startTime);
    latest = Math.max(latest, n.endTime);
    lowest = Math.min(lowest, n.pitch);
    highest = Math.max(highest, n.pitch);
  }
  let time = shift.time ?? 0;
  time = Math.max(time, -earliest);
  if (Number.isFinite(maxTime)) time = Math.min(time, Math.max(0, maxTime - latest));
  const pitch = Math.max(PIANO_MIN - lowest, Math.min(PIANO_MAX - highest, Math.round(shift.pitch ?? 0)));
  const start = shift.start ?? 0;
  const end = shift.end ?? 0;

  return group.map((n) => {
    let startTime = n.startTime + time;
    let endTime = n.endTime + time;
    if (start !== 0) startTime = Math.max(0, Math.min(endTime - MIN_LENGTH, startTime + start));
    if (end !== 0) endTime = Math.max(startTime + MIN_LENGTH, endTime + end);
    return normalizeNote({ ...n, pitch: n.pitch + pitch, startTime, endTime }, maxTime);
  });
}

/** True when at least two of the notes share a pitch, so `joinNotes` has something to do. */
export function canJoin(notes: readonly PianoNote[], indices: readonly number[]): boolean {
  const seen = new Set<number>();
  for (const i of indices) {
    const n = notes[i];
    if (!n) continue;
    if (seen.has(n.pitch)) return true;
    seen.add(n.pitch);
  }
  return false;
}

/** One note from the first start to the last end of `parts` (all the same pitch). */
export function mergeNotes(parts: readonly PianoNote[]): PianoNote {
  const ordered = [...parts].sort((a, b) => a.startTime - b.startTime);
  const first = ordered[0];
  let endTime = first.endTime;
  let sounding = 0;
  let weighted = 0;
  let hasConfidence = true;
  for (const n of ordered) {
    endTime = Math.max(endTime, n.endTime);
    const length = Math.max(0, n.endTime - n.startTime);
    sounding += length;
    if (n.confidence === undefined) hasConfidence = false;
    else weighted += n.confidence * length;
  }
  // The strike is the first part's; later parts are the same note still sounding.
  const merged: PianoNote = { pitch: first.pitch, startTime: first.startTime, endTime, velocity: first.velocity };
  if (hasConfidence) {
    merged.confidence = sounding > 0 ? Math.round((weighted / sounding) * 1000) / 1000 : first.confidence;
  }
  return merged;
}

/**
 * Join the selected notes pitch by pitch: every pitch with two or more
 * selected notes becomes one note spanning them. Returns the new note list
 * and the notes that should stay selected, or null if nothing can be joined.
 */
export function joinNotes(
  notes: readonly PianoNote[],
  indices: readonly number[],
): { notes: PianoNote[]; selected: PianoNote[] } | null {
  const byPitch = new Map<number, number[]>();
  for (const i of new Set(indices)) {
    const n = notes[i];
    if (!n) continue;
    const group = byPitch.get(n.pitch);
    if (group) group.push(i);
    else byPitch.set(n.pitch, [i]);
  }
  const removed = new Set<number>();
  const selected: PianoNote[] = [];
  let joined = false;
  for (const group of byPitch.values()) {
    if (group.length < 2) {
      selected.push(notes[group[0]]);
      continue;
    }
    joined = true;
    for (const i of group) removed.add(i);
    selected.push(mergeNotes(group.map((i) => notes[i])));
  }
  if (!joined) return null;
  const kept = notes.filter((_, i) => !removed.has(i));
  const added = selected.filter((n) => !kept.includes(n));
  return { notes: [...kept, ...added], selected };
}
