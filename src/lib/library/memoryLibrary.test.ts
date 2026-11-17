// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { MemoryLibrary } from './memoryLibrary';

async function recording(library: MemoryLibrary, notebookId: string) {
  const created = await library.create({ mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test', title: 'Riff', notebookId });
  await library.writeFile(created.id, 'media-chunk', new Uint8Array([1, 2, 3]));
  await library.finalize({ id: created.id, durationMs: 3000, hasVideo: false, videoWidth: null, videoHeight: null, countInMs: 500 });
  await library.writeFile(created.id, 'analysis', new Uint8Array([4]));
  await library.saveTranscription({
    id: created.id,
    engine: 'test',
    engineVersion: '1',
    params: {},
    notes: [{ pitch: 60, startTime: 0.5, endTime: 1, velocity: 80 }],
    summary: null,
  });
  return created.id;
}

describe('MemoryLibrary on the canvas', () => {
  it('remembers the playback mode per sketch, including on duplicates', async () => {
    const library = new MemoryLibrary();
    const notebook = await library.createNotebook('N');
    const id = await recording(library, notebook.id);
    const other = await recording(library, notebook.id);
    expect((await library.get(id)).listenMode).toBe('recording');
    await library.update({ id, listenMode: 'notes' });
    await library.update({ id, title: 'New title' });
    expect((await library.get(id)).listenMode).toBe('notes');
    expect((await library.list()).find((s) => s.id === id)?.listenMode).toBe('notes');
    expect((await library.get(other)).listenMode).toBe('recording');
    await library.saveTranscription({ id, engine: 'test', engineVersion: '2', params: {}, notes: [], summary: null });
    expect((await library.get(id)).listenMode).toBe('notes');
    await library.update({ id, listenMode: 'both' });
    const copy = await library.duplicate({ id, notebookId: notebook.id, canvasXMs: 4000, canvasY: 50 });
    expect(copy.listenMode).toBe('both');
    await expect(library.update({ id, listenMode: 'invalid' as 'notes' })).rejects.toThrow();
    expect((await library.get(id)).listenMode).toBe('both');
  });

  it('repeats a recording, within limits', async () => {
    const library = new MemoryLibrary();
    const notebook = await library.createNotebook('N');
    const id = await recording(library, notebook.id);
    expect((await library.get(id)).canvasRepeats).toBe(1);
    expect((await library.setRepeats(id, 4)).canvasRepeats).toBe(4);
    await expect(library.setRepeats(id, 0)).rejects.toThrow(/out of range/);
    await expect(library.setRepeats(id, 2.5)).rejects.toThrow(/out of range/);
  });

  it('duplicates a sketch onto another notebook, standing on its own', async () => {
    const library = new MemoryLibrary();
    const a = await library.createNotebook('A');
    const b = await library.createNotebook('B');
    const id = await recording(library, a.id);
    await library.setRepeats(id, 2);
    const copy = await library.duplicate({ id, notebookId: b.id, canvasXMs: 7000, canvasY: 120 });
    expect(copy.id).not.toBe(id);
    expect([copy.notebookId, copy.canvasXMs, copy.canvasY]).toEqual([b.id, 7000, 120]);
    expect([copy.title, copy.countInMs, copy.canvasRepeats]).toEqual(['Riff', 500, 2]);
    expect(copy.mediaPath).not.toBe((await library.get(id)).mediaPath);
    const detail = await library.get(copy.id);
    expect(detail.transcription?.originalNotes[0].pitch).toBe(60);
    expect(detail.tracks.map((t) => t.takeId)).toEqual([copy.id]);
    // Deleting the original leaves the copy (and its files) whole.
    await library.remove(id);
    const { resolveObjectURL } = await import('node:buffer');
    expect(resolveObjectURL(detail.mediaPath!)).toBeTruthy();
  });
});

describe('MemoryLibrary samples', () => {
  const wav = () => {
    const bytes = new Uint8Array(48);
    bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    bytes.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
    return bytes;
  };

  it('adds, edits and deletes samples; sketches playing one go back to the piano', async () => {
    const library = new MemoryLibrary();
    const notebook = await library.createNotebook('N');
    const id = await recording(library, notebook.id);
    const sample = await library.createSample({ title: ' Kick ', durationMs: 400, sourceSketchId: id, settings: { gainDb: -3 } }, wav());
    expect(sample.title).toBe('Kick');
    expect(sample.audioPath).toMatch(/^blob:/);
    const edited = await library.updateSample({ id: sample.id, settings: { reverb: 0.5 } });
    expect(edited.settings).toEqual({ reverb: 0.5 });
    expect(edited.updatedAt).toBeGreaterThan(sample.updatedAt);
    expect((await library.setNoteSample(id, sample.id)).noteSampleId).toBe(sample.id);
    const copy = await library.duplicate({ id, notebookId: notebook.id, canvasXMs: 0, canvasY: 0 });
    expect(copy.noteSampleId).toBe(sample.id);
    await library.removeSample(sample.id);
    expect(await library.listSamples()).toEqual([]);
    expect((await library.get(id)).noteSampleId).toBeNull();
    expect((await library.get(copy.id)).noteSampleId).toBeNull();
  });

  it('refuses what is not a sample', async () => {
    const library = new MemoryLibrary();
    await expect(library.createSample({}, new Uint8Array(10))).rejects.toThrow();
    await expect(library.createSample({ durationMs: 0 }, wav())).rejects.toThrow();
    await expect(library.updateSample({ id: 'nope' })).rejects.toThrow();
  });
});

