import { describe, expect, it } from 'vitest';
import type { PianoNote } from '../transcription/types';
import { canJoin, joinNotes, mergeSelection, notesInBox, shiftNotes } from './selection';

const n = (pitch: number, startTime: number, endTime: number, confidence?: number): PianoNote => ({
  pitch,
  startTime,
  endTime,
  velocity: 80,
  ...(confidence === undefined ? {} : { confidence }),
});

describe('notesInBox', () => {
  const notes = [n(60, 0, 1), n(64, 0.5, 2), n(67, 3, 4), n(72, 1.5, 1.8)];

  it('selects notes that overlap the time span within the pitch range', () => {
    expect(notesInBox(notes, { startTime: 0.8, endTime: 1.6, pitchLow: 60, pitchHigh: 70 })).toEqual([0, 1]);
    expect(notesInBox(notes, { startTime: 0, endTime: 5, pitchLow: 65, pitchHigh: 108 })).toEqual([2, 3]);
  });

  it('does not select notes that only touch the edge', () => {
    expect(notesInBox(notes, { startTime: 1, endTime: 1.4, pitchLow: 60, pitchHigh: 60 })).toEqual([]);
  });
});

describe('mergeSelection', () => {
  it('returns a sorted union', () => {
    expect(mergeSelection([3, 1], [2, 3, 0])).toEqual([0, 1, 2, 3]);
  });
});

describe('shiftNotes', () => {
  const group = [n(60, 0.2, 1), n(64, 1, 2)];

  it('moves a group rigidly and stops it at the start of the take', () => {
    const moved = shiftNotes(group, { time: -0.5 });
    expect(moved.map((x) => x.startTime)).toEqual([0, 0.8]);
    expect(moved.map((x) => x.endTime)).toEqual([0.8, 1.8]);
  });

  it('transposes a group and stops it at the ends of the keyboard', () => {
    expect(shiftNotes(group, { pitch: 2 }).map((x) => x.pitch)).toEqual([62, 66]);
    const top = shiftNotes([n(100, 0, 1), n(106, 0, 1)], { pitch: 12 });
    expect(top.map((x) => x.pitch)).toEqual([102, 108]);
  });

  it('resizes every note by the same amount, down to a minimum length', () => {
    expect(shiftNotes(group, { end: 0.25 }).map((x) => x.endTime)).toEqual([1.25, 2.25]);
    const shortened = shiftNotes(group, { end: -5 });
    expect(shortened.map((x) => Math.round((x.endTime - x.startTime) * 1000))).toEqual([30, 30]);
    expect(shiftNotes(group, { start: 0.5 }).map((x) => x.startTime)).toEqual([0.7, 1.5]);
  });

  it('keeps the rest of each note', () => {
    expect(shiftNotes([n(60, 0, 1, 0.4)], { time: 1 })[0]).toEqual({ ...n(60, 1, 2, 0.4) });
  });
});

describe('joinNotes', () => {
  it('joins fragments of the same pitch and leaves other pitches alone', () => {
    const notes = [n(48, 0, 1, 0.8), n(60, 0.5, 1), n(48, 1.5, 2, 0.4), n(48, 2.2, 3, 0.4)];
    expect(canJoin(notes, [0, 1, 2, 3])).toBe(true);
    const result = joinNotes(notes, [0, 1, 2, 3])!;
    expect(result.notes).toHaveLength(2);
    const joined = result.notes.find((x) => x.pitch === 48)!;
    expect(joined).toMatchObject({ startTime: 0, endTime: 3, velocity: 80 });
    // Confidence weighted by sounding time: (0.8×1 + 0.4×0.5 + 0.4×0.8) / 2.3
    expect(joined.confidence).toBeCloseTo(0.574, 3);
    expect(result.selected).toHaveLength(2);
    expect(result.selected).toContain(notes[1]);
    expect(result.selected).toContain(joined);
  });

  it('does nothing when no two selected notes share a pitch', () => {
    const notes = [n(48, 0, 1), n(60, 0.5, 1), n(48, 2, 3)];
    expect(canJoin(notes, [0, 1])).toBe(false);
    expect(joinNotes(notes, [0, 1])).toBeNull();
  });
});
