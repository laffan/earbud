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

/** Several parts, one MIDI track each (a multi-track sketch). Times are absolute seconds. */
export function tracksToMidi(parts: { name: string; notes: PianoNote[] }[], options: MidiExportOptions = {}): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(options.bpm ?? 120);
  if (options.title) midi.header.name = options.title;
  parts.forEach((part, i) => {
    const track = midi.addTrack();
    track.name = part.name;
    // Own channel per part, skipping the General MIDI drum channel.
    track.channel = i < 9 ? i : Math.min(15, i + 1);
    track.instrument.number = 0; // Acoustic Grand Piano
    for (const note of sortNotes(part.notes)) {
      const duration = note.endTime - note.startTime;
      if (duration <= 0 || note.startTime < 0) continue;
      track.addNote({
        midi: Math.round(note.pitch),
        time: note.startTime,
        duration,
        velocity: Math.min(1, Math.max(1 / 127, note.velocity / 127)),
      });
    }
  });
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

/** Most notes taken from an imported file. */
const MAX_IMPORTED_NOTES = 20000;

/**
 * Notes of a MIDI file to import as a track: every track and channel except
 * General MIDI percussion (channel 10), with times in seconds as the file's
 * tempo map gives them. Throws if the bytes are not a MIDI file.
 */
export function midiFileToNotes(bytes: Uint8Array): PianoNote[] {
  const midi = new Midi(bytes);
  const notes: PianoNote[] = [];
  for (const track of midi.tracks) {
    if (track.channel === 9 || track.instrument.percussion) continue;
    for (const n of track.notes) {
      if (!(n.duration > 0) || !(n.time >= 0) || n.midi < 0 || n.midi > 127) continue;
      notes.push({
        pitch: n.midi,
        startTime: n.time,
        endTime: n.time + n.duration,
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
        confidence: 1,
      });
      if (notes.length >= MAX_IMPORTED_NOTES) return sortNotes(notes);
    }
  }
  return sortNotes(notes);
}
