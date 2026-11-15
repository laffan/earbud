// @vitest-environment happy-dom
import { Midi } from '@tonejs/midi';
import { describe, expect, it } from 'vitest';
import { encodeWav16 } from '../audio/wav';
import type { PianoNote } from '../transcription/types';
import { fileStem, importAudioSketch, importMidiSketch, MIDI_IMPORT_ENGINE } from './importTrack';
import { MemoryLibrary } from './memoryLibrary';

async function notebook(library: MemoryLibrary) {
  return (await library.createNotebook('Imports')).id;
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

describe('importing a sketch onto a canvas', () => {
  it('turns a MIDI file into a sketch with its notes, rendered audio and a waveform', async () => {
    const library = new MemoryLibrary();
    const notebookId = await notebook(library);
    const result = await importMidiSketch({ library, render }, midiFile('Bassline.mid'), { notebookId, canvasXMs: 2000, canvasY: 80 });
    expect(result.transcribe).toBe(false);
    expect(result.sketch.title).toBe('Bassline');

    const detail = await library.get(result.sketch.id);
    expect(detail.notebookId).toBe(notebookId);
    expect([detail.canvasXMs, detail.canvasY]).toEqual([2000, 80]);
    expect(detail.status).toBe('saved');
    expect(detail.transcriptionStatus).toBe('done');
    expect(detail.transcription?.engine).toBe(MIDI_IMPORT_ENGINE);
    // The drum channel is left out; the rest is as written.
    expect(detail.transcription?.originalNotes.map((n) => [n.pitch, n.startTime, n.endTime])).toEqual([
      [36, 0.5, 1.5],
      [43, 1.5, 2],
    ]);
    expect(detail.analysisPath).not.toBeNull();
    expect(detail.durationMs).toBe(3500);
  });

  it('copies an audio file in as a sketch to transcribe, named after the file', async () => {
    const library = new MemoryLibrary();
    const notebookId = await notebook(library);
    const wav = encodeWav16([new Float32Array(22050)], 22050);
    const file = new File([wav.slice()], 'Night take (2).wav', { type: 'audio/wav' });
    const probe = async () => ({ durationMs: 1000, hasVideo: false, width: null, height: null });
    const result = await importAudioSketch({ library, probe }, file, { notebookId, canvasXMs: 0, canvasY: 0 });
    expect(result.transcribe).toBe(true);
    expect(result.sketch.title).toBe('Night take (2)');
    expect(result.sketch.mediaMime).toBe('audio/wav');
    expect(result.sketch.durationMs).toBe(1000);
    expect(result.sketch.transcriptionStatus).toBe('pending');
    expect(result.sketch.captureBackend).toBe('import');
    expect(result.sketch.notebookId).toBe(notebookId);
    const stored = await (await fetchBlob(result.sketch.mediaPath!)).arrayBuffer();
    expect(new Uint8Array(stored)).toEqual(wav);
  });

  it('leaves nothing behind when a file cannot be imported', async () => {
    const library = new MemoryLibrary();
    const notebookId = await notebook(library);
    const place = { notebookId, canvasXMs: 0, canvasY: 0 };
    const junk = new File([new Uint8Array([1, 2, 3, 4])], 'notes.mid');
    await expect(importMidiSketch({ library, render }, junk, place)).rejects.toThrow(/not a MIDI file/);
    const empty = new File([], 'silence.wav', { type: 'audio/wav' });
    const probe = async () => ({ durationMs: null, hasVideo: false, width: null, height: null });
    await expect(importAudioSketch({ library, probe }, empty, place)).rejects.toThrow(/empty/);
    let calls = 0;
    const failing = async (notes: PianoNote[], rate: number) => {
      if (++calls === 2) throw new Error('no audio');
      return render(notes, rate);
    };
    await expect(importMidiSketch({ library, render: failing }, midiFile('x.mid'), place)).rejects.toThrow('no audio');
    expect(await library.list()).toHaveLength(0);
  });

  it('names sketches after their files', () => {
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
