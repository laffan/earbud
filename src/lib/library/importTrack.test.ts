// @vitest-environment happy-dom
import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { encodeWav16 } from '../audio/wav';
import type { PianoNote } from '../transcription/types';
import { fileStem, importAudioTrack, importMidiTrack, MIDI_IMPORT_ENGINE } from './importTrack';
import { MemoryLibrary } from './memoryLibrary';

async function sketch(library: MemoryLibrary) {
  const created = await library.create({ mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test' });
  await library.writeFile(created.id, 'media-chunk', encodeWav16([new Float32Array(4410)], 44100));
  await library.finalize({ id: created.id, durationMs: 100, hasVideo: false, videoWidth: null, videoHeight: null });
  return created.id;
}

/** A silent WAV as long as the notes (instead of the synth, which needs Web Audio). */
const render = async (notes: PianoNote[], sampleRate: number) =>
  encodeWav16([new Float32Array(Math.ceil((Math.max(...notes.map((n) => n.endTime)) + 1.5) * sampleRate))], sampleRate);

function midiFile(name: string): File {
  const midi = new Midi();
  const bass = midi.addTrack();
  bass.channel = 0;
  bass.addNote({ midi: 36, time: 0.5, duration: 1, velocity: 0.8 });
  bass.addNote({ midi: 43, time: 1.5, duration: 0.5, velocity: 0.6 });
  const drums = midi.addTrack();
  drums.channel = 9;
  drums.addNote({ midi: 38, time: 1, duration: 0.1, velocity: 1 });
  return new File([midi.toArray().slice()], name, { type: 'audio/midi' });
}

describe('importing a track', () => {
  it('turns a MIDI file into a track with its notes, rendered audio and a waveform', async () => {
    const library = new MemoryLibrary();
    const id = await sketch(library);
    const result = await importMidiTrack({ library, render }, id, midiFile('Bassline.mid'), 2000);
    expect(result.transcribe).toBe(false);
    expect(result.track.name).toBe('Bassline');

    const detail = await library.get(id);
    expect(detail.tracks).toHaveLength(2);
    const take = await library.get(detail.tracks[1].takeId);
    expect(take.offsetMs).toBe(2000);
    expect(take.status).toBe('saved');
    expect(take.transcriptionStatus).toBe('done');
    expect(take.transcription?.engine).toBe(MIDI_IMPORT_ENGINE);
    // The drum channel is left out; the rest is as written.
    expect(take.transcription?.originalNotes.map((n) => [n.pitch, n.startTime, n.endTime])).toEqual([
      [36, 0.5, 1.5],
      [43, 1.5, 2],
    ]);
    expect(take.analysisPath).not.toBeNull();
    expect(take.durationMs).toBe(3500);
  });

  it('copies an audio file in as a take to transcribe, named after the file', async () => {
    const library = new MemoryLibrary();
    const id = await sketch(library);
    const wav = encodeWav16([new Float32Array(22050)], 22050);
    const file = new File([wav.slice()], 'Night take (2).wav', { type: 'audio/wav' });
    const probe = async () => ({ durationMs: 1000, hasVideo: false, width: null, height: null });
    const result = await importAudioTrack({ library, probe }, id, file, 0);
    expect(result.transcribe).toBe(true);
    expect(result.track.name).toBe('Night take (2)');
    expect(result.take.mediaMime).toBe('audio/wav');
    expect(result.take.durationMs).toBe(1000);
    expect(result.take.transcriptionStatus).toBe('pending');
    expect(result.take.captureBackend).toBe('import');
    const stored = await (await fetchBlob(result.take.mediaPath!)).arrayBuffer();
    expect(new Uint8Array(stored)).toEqual(wav);
  });

  it('leaves nothing behind when a file cannot be imported', async () => {
    const library = new MemoryLibrary();
    const id = await sketch(library);
    const junk = new File([new Uint8Array([1, 2, 3, 4])], 'notes.mid');
    await expect(importMidiTrack({ library, render }, id, junk, 0)).rejects.toThrow(/not a MIDI file/);
    const empty = new File([], 'silence.wav', { type: 'audio/wav' });
    const probe = async () => ({ durationMs: null, hasVideo: false, width: null, height: null });
    await expect(importAudioTrack({ library, probe }, id, empty, 0)).rejects.toThrow(/empty/);
    let calls = 0;
    const failing = async (notes: PianoNote[], rate: number) => {
      if (++calls === 2) throw new Error('no audio');
      return render(notes, rate);
    };
    await expect(importMidiTrack({ library, render: failing }, id, midiFile('x.mid'), 0)).rejects.toThrow('no audio');
    expect((await library.get(id)).tracks).toHaveLength(1);
    expect((await library.list()).filter((s) => s.parentId === id)).toHaveLength(0);
  });

  it('names tracks after their files', () => {
    expect(fileStem('/Users/me/Music/Waltz in A.final.m4a')).toBe('Waltz in A.final');
    expect(fileStem('.hidden')).toBe('.hidden');
    expect(fileStem('  .mid')).toBe('Imported');
  });
});

/** happy-dom cannot fetch blob: URLs, which the in-memory library hands out. */
async function fetchBlob(url: string): Promise<Blob> {
  const { resolveObjectURL } = await import('node:buffer');
  const blob = resolveObjectURL(url);
  if (!blob) throw new Error(`no blob at ${url}`);
  return blob as unknown as Blob;
}
