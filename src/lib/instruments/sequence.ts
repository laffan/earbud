/** Compile to absolute seconds once. Native engines own all playback clocks. */
import { Midi } from '@tonejs/midi';
import { parseMidi } from 'midi-file';
import { midiFileToNotes, notesToMidi } from '../music/midi';
import type { SketchDetail } from '../library/types';
import type { MidiEvent, MidiSnapshot } from './types';

export function midiEvents(bytes: Uint8Array): MidiEvent[] {
  const file = parseMidi(bytes);
  if (file.header.format === 2) throw new Error('Independent-track MIDI format 2 is not supported for playback. Export a format 0 or 1 file.');
  const all = file.tracks.flatMap((track, index) => {
    let tick = 0;
    return track.map((event, order) => { tick += event.deltaTime; return { tick, event, index, order }; });
  }).sort((a, b) => a.tick - b.tick || a.index - b.index || a.order - b.order);
  let previous = 0, seconds = 0, tempo = 500000;
  const out: MidiEvent[] = [];
  for (const { tick, event } of all) {
    const ppq = file.header.ticksPerBeat;
    const ticksPerSecond = ppq ? ppq * 1e6 / tempo : (file.header.framesPerSecond ?? 0) * (file.header.ticksPerFrame ?? 0);
    if (!(ticksPerSecond > 0)) throw new Error('Invalid MIDI time division.');
    seconds += (tick - previous) / ticksPerSecond; previous = tick;
    if (event.type === 'setTempo') { tempo = event.microsecondsPerBeat; continue; }
    let message: number[] | null = null;
    if ('channel' in event) {
      const ch = event.channel;
      switch (event.type) {
        case 'noteOn': message = [event.velocity ? 0x90 | ch : 0x80 | ch, event.noteNumber, event.velocity]; break;
        case 'noteOff': message = [0x80 | ch, event.noteNumber, event.velocity]; break;
        case 'controller': message = [0xb0 | ch, event.controllerType, event.value]; break;
        case 'programChange': message = [0xc0 | ch, event.programNumber]; break;
        case 'pitchBend': { const value = event.value + 8192; message = [0xe0 | ch, value & 127, value >> 7]; break; }
        case 'noteAftertouch': message = [0xa0 | ch, event.noteNumber, event.amount]; break;
        case 'channelAftertouch': message = [0xd0 | ch, event.amount]; break;
      }
    } else if (event.type === 'sysEx') {
      message = [0xf0, ...Array.from(event.data)];
      if (message.at(-1) !== 0xf7) message.push(0xf7);
    } else if (event.type === 'endSysEx') {
      throw new Error('Split/escaped SysEx events are unsupported for native playback. The original file is retained for export.');
    }
    if (message) out.push({ time: seconds, bytes: message });
  }
  return out.sort((a,b) => a.time-b.time || priority(a)-priority(b));
}
function priority(e: MidiEvent) { return (e.bytes[0] & 0xf0) === 0x80 ? 0 : (e.bytes[0] & 0xf0) === 0x90 ? 2 : 1; }

/** Exact imported SMF, including its tempo map, when edits have not superseded it. */
export function snapshotMidi(detail: SketchDetail, original?: Uint8Array): { midi: Uint8Array; snapshot: MidiSnapshot } {
  const t = detail.transcription;
  const notes = structuredClone(t?.editedNotes ?? t?.originalNotes ?? []);
  // The legacy piano importer hides percussion, while the immutable SMF
  // retains it. Include those notes in a round trip without changing any
  // existing editable note's time or velocity.
  if (!detail.hasEdits && original && !notes.some(n => n.channel === 9)) {
    notes.push(...midiFileToNotes(original, true).filter(n => n.channel === 9));
  }
  if (!notes.length) throw new Error('This sketch has no MIDI notes yet.');
  const midi = !detail.hasEdits && original ? original.slice() : notesToMidi(notes, { title: detail.title, bpm: detail.tempoBpm ?? 120 });
  const parsed = new Midi(midi);
  return { midi, snapshot: { notes, tempoBpm: detail.tempoBpm ?? parsed.header.tempos[0]?.bpm ?? 120,
    metadata: { notebookId: detail.notebookId, canvasXMs: detail.canvasXMs, canvasY: detail.canvasY,
      tracks: parsed.tracks.map(t => ({ name: t.name, channel: t.channel, instrument: t.instrument.number })), tempos: parsed.header.tempos,
    } } };
}
