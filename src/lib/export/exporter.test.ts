// @vitest-environment happy-dom
import { resolveObjectURL } from 'node:buffer';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeWav16 } from '../audio/wav';
import type { CaptureEngine } from '../capture/types';
import { MemoryLibrary } from '../library/memoryLibrary';
import { midiToNotes } from '../music/midi';
import { prepareExports } from './exporter';

async function sketchWith(library: MemoryLibrary, opts: { title: string; transcribed: boolean }) {
  const created = await library.create({
    mediaExtension: 'mov',
    mediaMime: 'video/quicktime',
    captureBackend: 'test',
    title: opts.title,
  });
  await library.writeFile(created.id, 'media-chunk', new Uint8Array([1, 2, 3]));
  await library.finalize({ id: created.id, durationMs: 2000, hasVideo: true, videoWidth: 1280, videoHeight: 720 });
  await library.writeFile(created.id, 'analysis', encodeWav16([new Float32Array(2205)], 22050));
  if (opts.transcribed) {
    await library.saveTranscription({
      id: created.id,
      engine: 'test',
      engineVersion: '1',
      params: {},
      notes: [{ pitch: 60, startTime: 0.1, endTime: 0.6, velocity: 90 }],
      summary: null,
    });
    // An edit: exports must use the corrected notes.
    await library.saveEdits({
      id: created.id,
      notes: [{ pitch: 62, startTime: 0.1, endTime: 0.6, velocity: 90 }],
      summary: null,
    });
  }
  return created.id;
}

beforeAll(() => {
  // happy-dom cannot fetch blob: URLs (the in-memory library's files).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('blob:')) {
      const blob = resolveObjectURL(url);
      return blob ? new Response(await blob.arrayBuffer()) : new Response(null, { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

describe('prepareExports', () => {
  it('exports the selected kinds with friendly names, using edited notes', async () => {
    const library = new MemoryLibrary();
    const id = await sketchWith(library, { title: 'Waltz', transcribed: true });
    const result = await prepareExports([id], ['midi', 'recording'], { library, capture: null });
    expect(result.files.map((f) => [f.kind, f.name])).toEqual([
      ['recording', 'Waltz.mov'],
      ['midi', 'Waltz.mid'],
    ]);
    const midi = new Uint8Array(await (await fetch(result.files[1].path)).arrayBuffer());
    expect(midiToNotes(midi).map((n) => n.pitch)).toEqual([62]);
    expect(result.skipped).toEqual([]);
  });

  it('skips notes for untranscribed sketches and falls back when native audio export fails', async () => {
    const library = new MemoryLibrary();
    const done = await sketchWith(library, { title: 'A', transcribed: true });
    const pending = await sketchWith(library, { title: 'B', transcribed: false });
    const failingCapture = {
      id: 'test',
      exportAudio: async () => {
        throw new Error('no exporter');
      },
    } as unknown as CaptureEngine;
    const result = await prepareExports([done, pending], ['audio', 'midi'], { library, capture: failingCapture });
    expect(result.files.map((f) => f.name)).toEqual(['A (audio).wav', 'A.mid', 'B (audio).wav']);
    expect(result.skipped).toEqual(['B: no transcription yet, so no notes or MIDI']);
  });
});

describe('multi-track exports', () => {
  it('writes a MIDI track per track, on the sketch timeline, and takes the video from the shown take', async () => {
    const library = new MemoryLibrary();
    const id = await sketchWith(library, { title: 'Duet', transcribed: true });
    const take = await library.create({ mediaExtension: 'webm', mediaMime: 'video/webm', captureBackend: 'test', parentId: id });
    await library.writeFile(take.id, 'media-chunk', new Uint8Array([4, 5, 6]));
    await library.finalize({ id: take.id, durationMs: 2000, hasVideo: false, videoWidth: null, videoHeight: null, offsetMs: 1500 });
    await library.saveTranscription({
      id: take.id,
      engine: 'test',
      engineVersion: '1',
      params: {},
      notes: [{ pitch: 72, startTime: 0.5, endTime: 1, velocity: 90 }],
      summary: null,
    });
    await library.updateTrack({ id: take.trackId, name: 'Melody' });

    const result = await prepareExports([id], ['midi', 'recording'], { library, capture: null });
    expect(result.files.map((f) => [f.kind, f.name])).toEqual([
      ['recording', 'Duet.mov'],
      ['midi', 'Duet.mid'],
    ]);
    const { Midi } = await import('@tonejs/midi');
    const midi = new Midi(new Uint8Array(await (await fetch(result.files[1].path)).arrayBuffer()));
    expect(midi.tracks.map((t) => t.name)).toEqual(['Track 1', 'Melody']);
    expect(midi.tracks[0].notes.map((n) => n.midi)).toEqual([62]);
    expect(midi.tracks[1].notes[0].midi).toBe(72);
    expect(midi.tracks[1].notes[0].time).toBeCloseTo(2, 2); // 0.5 s into a take that starts at 1.5 s
  });
});

describe('mixing takes', () => {
  it('places parts at their offsets and only scales down to avoid clipping', async () => {
    const { mixParts } = await import('../audio/analysisAudio');
    const one = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const two = new Float32Array([0.25, 0.25]);
    expect([...mixParts([{ samples: one, offset: 0 }, { samples: two, offset: 2 }], 1)]).toEqual([0.5, 0.5, 0.75, 0.75]);
    // A part that starts before the timeline is cut at 0.
    expect([...mixParts([{ samples: two, offset: -1 }], 1)]).toEqual([0.25]);
    const loud = mixParts([{ samples: new Float32Array([0.9]), offset: 0 }, { samples: new Float32Array([0.9]), offset: 0 }], 1);
    expect(loud[0]).toBeCloseTo(0.98, 5);
  });
});
