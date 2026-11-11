/** Standard MIDI File export via @tonejs/midi. */
import { Midi } from '@tonejs/midi';
import type { PianoNote } from '../transcription/types';
import { sortNotes } from './notes';

export interface MidiExportOptions {
  title?: string;
  /** Written as the file tempo; note times are absolute seconds regardless. */
  bpm?: number;
}

export function notesToMidi(notes: PianoNote[], options: MidiExportOptions = {}): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(options.bpm ?? 120);
  if (options.title) midi.header.name = options.title;
  const track = midi.addTrack();
  track.name = 'Piano';
  track.channel = 0;
  track.instrument.number = 0; // Acoustic Grand Piano
  for (const note of sortNotes(notes)) {
    const duration = note.endTime - note.startTime;
    if (duration <= 0) continue;
    track.addNote({
      midi: Math.round(note.pitch),
      time: note.startTime,
      duration,
      velocity: Math.min(1, Math.max(1 / 127, note.velocity / 127)),
    });
  }
  return midi.toArray();
}

/** Parse a MIDI file back into notes (used by tests and future import). */
export function midiToNotes(bytes: Uint8Array): PianoNote[] {
  const midi = new Midi(bytes);
  const notes: PianoNote[] = [];
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      notes.push({
        pitch: n.midi,
        startTime: n.time,
        endTime: n.time + n.duration,
        velocity: Math.round(n.velocity * 127),
      });
    }
  }
  return sortNotes(notes);
}
