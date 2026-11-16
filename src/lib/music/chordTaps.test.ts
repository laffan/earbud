import { describe, expect, it } from 'vitest';
import { chordTapsTitle, MAX_LAST, notesFromChordTaps, type ChordTap } from './chordTaps';

const C: Omit<ChordTap, 'time'> = { pitches: [48, 64, 67, 60], symbol: 'C' };
const G: Omit<ChordTap, 'time'> = { pitches: [43, 59, 62, 67], symbol: 'G' };

describe('notesFromChordTaps', () => {
  it('holds each chord until the next tap, starting from the first tap', () => {
    const notes = notesFromChordTaps([{ ...C, time: 10 }, { ...G, time: 11.5 }], 13);
    const c = notes.filter((n) => n.startTime === 0);
    const g = notes.filter((n) => n.startTime === 1.5);
    expect(c.map((n) => n.pitch)).toEqual([48, 60, 64, 67]);
    expect(c.every((n) => n.endTime === 1.5)).toBe(true);
    expect(g.every((n) => n.endTime === 3)).toBe(true);
  });

  it('holds the last chord until recording stops, but not for ever', () => {
    const notes = notesFromChordTaps([{ ...C, time: 2 }], 60);
    expect(notes[0].endTime).toBe(MAX_LAST);
  });

  it('gives a chord tapped twice in a hurry a little length, and nothing for no taps', () => {
    const notes = notesFromChordTaps([{ ...C, time: 1 }, { ...C, time: 1 }], 1);
    expect(notes.every((n) => n.endTime > n.startTime)).toBe(true);
    expect(notesFromChordTaps([], 5)).toEqual([]);
  });
});

describe('chordTapsTitle', () => {
  it('names the chords in order, once per change', () => {
    const taps = [C, C, G, C].map((t, i) => ({ ...t, time: i }));
    expect(chordTapsTitle(taps)).toBe('C – G – C');
    expect(chordTapsTitle([])).toBe('Chords');
    expect(chordTapsTitle([C, G, C, G].map((t, i) => ({ ...t, time: i })), 2)).toBe('C – G …');
  });
});
