import { describe, expect, it } from 'vitest';
import type { PianoNote } from '../transcription/types';
import { chordProgression, detectChords } from './chords';
import { midiToNotes, notesToMidi } from './midi';
import { normalizeNote, noteName } from './notes';
import { summarize } from './summary';

const chord = (pitches: number[], start: number, end: number, velocity = 80): PianoNote[] =>
  pitches.map((pitch) => ({ pitch, startTime: start, endTime: end, velocity, confidence: 0.8 }));

describe('chord detection', () => {
  it('names root-position triads and sevenths', () => {
    const notes = [
      ...chord([48, 60, 64, 67], 0, 1),
      ...chord([45, 57, 60, 64, 67], 1, 2),
      ...chord([41, 57, 60, 65], 2, 3),
      ...chord([43, 55, 59, 62, 65], 3, 4),
    ];
    expect(detectChords(notes).map((c) => c.symbol)).toEqual(['C', 'Am7', 'F', 'G7']);
  });

  it('writes inversions as slash chords', () => {
    expect(detectChords(chord([52, 60, 67, 72], 0, 1))[0].symbol).toBe('C/E');
  });

  it('keeps a held chord intact under a moving melody', () => {
    const notes = [
      ...chord([48, 55, 64], 0, 2),
      { pitch: 72, startTime: 0, endTime: 0.5, velocity: 90 },
      { pitch: 74, startTime: 0.5, endTime: 1, velocity: 90 },
      { pitch: 76, startTime: 1, endTime: 1.5, velocity: 90 },
      { pitch: 79, startTime: 1.5, endTime: 2, velocity: 90 },
    ];
    const chords = detectChords(notes);
    expect(chords).toHaveLength(1);
    expect(chords[0].symbol).toBe('C');
    expect(chords[0].endTime).toBe(2);
  });

  it('stays silent for single notes and dyads', () => {
    expect(detectChords([{ pitch: 60, startTime: 0, endTime: 1, velocity: 80 }])).toEqual([]);
    expect(detectChords(chord([60, 67], 0, 1))).toEqual([]);
  });

  it('accepts a seventh chord voiced without its fifth', () => {
    expect(detectChords(chord([43, 53, 59, 67], 0, 1))[0].symbol).toBe('G7');
  });

  it('builds a progression summary', () => {
    const notes = [...chord([48, 52, 55], 0, 1), ...chord([45, 48, 52], 1, 2), ...chord([48, 52, 55], 2, 3)];
    expect(chordProgression(detectChords(notes))).toEqual(['C', 'Am', 'C']);
  });
});

describe('midi', () => {
  it('round-trips notes through a Standard MIDI File', () => {
    const notes = [...chord([60, 64, 67], 0.5, 1.5, 100), { pitch: 72, startTime: 1.25, endTime: 2, velocity: 64 }];
    const bytes = notesToMidi(notes, { title: 'Test' });
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    const back = midiToNotes(bytes);
    expect(back.map((n) => n.pitch)).toEqual([60, 64, 67, 72]);
    expect(back[0].startTime).toBeCloseTo(0.5, 2);
    expect(back[3].endTime).toBeCloseTo(2, 2);
    expect(back[0].velocity).toBe(100);
  });
});

describe('notes', () => {
  it('names notes in lead-sheet spelling', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(61)).toBe('D♭4');
    expect(noteName(21)).toBe('A0');
  });

  it('normalizes edited notes', () => {
    const n = normalizeNote({ pitch: 130, startTime: -1, endTime: -0.5, velocity: 300 }, 10);
    expect(n).toEqual({ pitch: 108, startTime: 0, endTime: 0.02, velocity: 127 });
  });

  it('summarizes with chords and a bounded preview', () => {
    const many: PianoNote[] = [];
    for (let i = 0; i < 400; i++) many.push({ pitch: 60 + (i % 12), startTime: i * 0.1, endTime: i * 0.1 + 0.2, velocity: 70 });
    const summary = summarize(many);
    expect(summary.noteCount).toBe(400);
    expect(summary.preview.length).toBeLessThanOrEqual(240);
    expect(summary.pitchRange).toEqual([60, 71]);
  });
});
