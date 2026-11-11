/**
 * Small, precomputed digest of a transcription stored with each sketch so
 * the library list can show chords and a mini piano roll without loading
 * every note.
 */
import type { PianoNote } from '../transcription/types';
import { chordProgression, detectChords, type ChordSegment } from './chords';
import { pitchRange, sortNotes } from './notes';

export interface SketchSummary {
  noteCount: number;
  chords: string[];
  pitchRange: [number, number] | null;
  /** Up to ~240 notes as [pitch, start, end] for thumbnails. */
  preview: [number, number, number][];
}

const PREVIEW_LIMIT = 240;

export function summarize(notes: PianoNote[], chords?: ChordSegment[]): SketchSummary {
  const sorted = sortNotes(notes);
  const segments = chords ?? detectChords(sorted);
  let preview = sorted;
  if (sorted.length > PREVIEW_LIMIT) {
    // Keep the most confident/longest notes, then restore time order.
    preview = [...sorted]
      .sort(
        (a, b) =>
          (b.confidence ?? 1) * (b.endTime - b.startTime) - (a.confidence ?? 1) * (a.endTime - a.startTime),
      )
      .slice(0, PREVIEW_LIMIT);
    preview = sortNotes(preview);
  }
  return {
    noteCount: notes.length,
    chords: chordProgression(segments, 8),
    pitchRange: pitchRange(notes),
    preview: preview.map((n) => [n.pitch, round2(n.startTime), round2(n.endTime)]),
  };
}

function round2(x: number) {
  return Math.round(x * 100) / 100;
}
