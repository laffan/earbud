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
