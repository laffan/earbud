// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { MemoryLibrary } from '../library/memoryLibrary';
import type { ListenMode } from '../library/types';
import type { PianoNote } from '../transcription/types';
import { FakeAudioContext, fakeBuffer } from '../testing/fakeAudioContext';
import { loadCanvasSound, type AudioLayer } from './canvasAudio';

async function fixture(mode: ListenMode) {
  const library = new MemoryLibrary();
  const notebook = await library.createNotebook('N');
  const { id } = await library.create({ notebookId: notebook.id, mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test' });
  await library.writeFile(id, 'media-chunk', new Uint8Array([1]));
  await library.finalize({ id, durationMs: 4000, hasVideo: false, videoWidth: null, videoHeight: null });
  await library.saveTranscription({ id, engine: 'test', engineVersion: '1', params: {}, summary: null,
    notes: [{ pitch: 60, startTime: 0.5, endTime: 1, velocity: 80 }] });
  await library.saveEdits({ id, summary: null, notes: [{ pitch: 72, startTime: 1, endTime: 2, velocity: 90 }] });
  await library.update({ id, listenMode: mode });
  const recording = fakeBuffer(4);
  const rendered = fakeBuffer(3.5);
  const load = vi.fn(async () => recording);
  const renderNotes = vi.fn(async (_notes: PianoNote[]) => rendered);
  const mix = vi.fn(async (layers: AudioLayer[], duration: number) => layers.length === 1 ? layers[0].buffer : fakeBuffer(duration));
  const ctx = new FakeAudioContext() as unknown as AudioContext;
  return { library, id, ctx, recording, rendered, load, renderNotes, mix };
}

describe('canvas playback source', () => {
  it('plays Take without rendering notes', async () => {
    const f = await fixture('recording');
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(sound.buffer).toBe(f.recording);
    expect(sound.recording).toBe(f.recording);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.renderNotes).not.toHaveBeenCalled();
  });

  it('plays Notes using edited notes and never loads the recording', async () => {
    const f = await fixture('notes');
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.renderNotes.mock.calls[0][0]).toEqual([{ pitch: 72, startTime: 1, endTime: 2, velocity: 90 }]);
    expect(sound.buffer).toBe(f.rendered);
    expect(sound.notes[0].pitch).toBe(72);
    expect(sound.duration).toBe(4); // choosing Notes doesn't shorten the clip/repeat interval
    expect(sound.recording).toBeNull();
  });

  it('mixes Both on the same timeline and keeps the original waveform', async () => {
    const f = await fixture('both');
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(f.mix.mock.calls.at(-1)?.[0]).toEqual([
      { buffer: f.recording, offset: 0 }, { buffer: f.rendered, offset: 0 },
    ]);
    expect(sound.recording).toBe(f.recording);
    expect(sound.notes[0].pitch).toBe(72);
  });

  it('keeps deleted notes silent rather than falling back to the original transcription or take', async () => {
    const f = await fixture('notes');
    await f.library.saveEdits({ id: f.id, notes: [], summary: null });
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(sound.notes).toEqual([]);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.renderNotes).not.toHaveBeenCalled();
    expect(f.mix.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it('uses the active take, solo/mute, and its offset for both notes and recording', async () => {
    const f = await fixture('both');
    const next = await f.library.create({ parentId: f.id, mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test' });
    await f.library.writeFile(next.id, 'media-chunk', new Uint8Array([2]));
    await f.library.finalize({ id: next.id, durationMs: 4000, hasVideo: false, videoWidth: null, videoHeight: null, offsetMs: 1000 });
    await f.library.saveTranscription({ id: next.id, engine: 'test', engineVersion: '1', params: {}, summary: null,
      notes: [{ pitch: 84, startTime: 0.5, endTime: 1, velocity: 70 }] });
    await f.library.updateTrack({ id: next.trackId, solo: true });
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(sound.notes).toEqual([{ pitch: 84, startTime: 1.5, endTime: 2, velocity: 70 }]);
    expect(f.mix.mock.calls[0][0][0].offset).toBe(1);
    expect(sound.duration).toBe(5);
  });

  it('can play the notes in Both if the original recording cannot be decoded', async () => {
    const f = await fixture('both');
    f.load.mockRejectedValue(new Error('unsupported format'));
    const sound = await loadCanvasSound(f.ctx, await f.library.get(f.id), f.library, f);
    expect(sound.buffer).toBe(f.rendered);
    expect(sound.recording).toBeNull();
  });
});
