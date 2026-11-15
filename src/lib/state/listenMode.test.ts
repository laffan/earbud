// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLibrary } from '../library/memoryLibrary';
import { AppState } from './app.svelte';

beforeEach(() => localStorage.clear());

async function setup() {
  const library = new MemoryLibrary();
  const { id } = await library.create({ mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test' });
  await library.writeFile(id, 'media-chunk', new Uint8Array([1]));
  const sketch = await library.finalize({ id, durationMs: 3000, hasVideo: false, videoWidth: null, videoHeight: null });
  const app = new AppState({ library, captureEngine: null });
  app.upsert(sketch);
  return { library, id, app };
}

describe('saved playback choice', () => {
  it('applies the latest tap immediately and serializes writes so old replies cannot undo it', async () => {
    const { library, id, app } = await setup();
    const update = library.update.bind(library);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(library, 'update').mockImplementationOnce(async (args) => {
      await gate;
      return update(args);
    });
    const first = app.setListenMode(id, 'notes');
    const last = app.setListenMode(id, 'both');
    expect(app.sketches[0].listenMode).toBe('both');
    release();
    await first;
    expect(app.sketches[0].listenMode).toBe('both');
    await last;
    expect((await library.get(id)).listenMode).toBe('both');
    const reopened = new AppState({ library, captureEngine: null });
    await reopened.refresh();
    expect(reopened.sketches[0].listenMode).toBe('both');
  });

  it('restores the saved choice if a write fails', async () => {
    const { library, id, app } = await setup();
    vi.spyOn(library, 'update').mockRejectedValueOnce(new Error('disk full'));
    await expect(app.setListenMode(id, 'notes')).rejects.toThrow('disk full');
    expect(app.sketches[0].listenMode).toBe('recording');
    expect((await library.get(id)).listenMode).toBe('recording');
  });
});
