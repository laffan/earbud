/**
 * Playback choice from sketch to canvas: real audio buffers, edited notes,
 * waveform/piano-roll previews, crop/repeats and reopening the sketch.
 * Run against `npm run dev`: npm run smoke:listen
 * Native cross-launch persistence is covered by the SQLite library tests.
 */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__sources = [];
      window.__heard = {};
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
        if (this.buffer?.length > 1 && this.context instanceof AudioContext) {
          window.__sources.push({ buffer: this.buffer, when, offset, duration });
        }
        return start.apply(this, arguments);
      };
    });
    await page.goto(URL);
    await page.waitForSelector('.canvas');
    const id = await page.evaluate(async () => {
      const { app } = await import('/src/lib/state/app.svelte.ts');
      const { encodeWav16 } = await import('/src/lib/audio/wav.ts');
      const { summarize } = await import('/src/lib/music/summary.ts');
      app.updateSettings({ autoTranscribe: false });
      const created = await app.library.create({
        notebookId: app.notebookId, canvasXMs: 0, canvasY: 40,
        title: 'Playback choice', mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'test',
      });
      const rate = 44100;
      const samples = Float32Array.from({ length: rate * 4 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 220 * i / rate));
      await app.library.writeFile(created.id, 'media-chunk', encodeWav16([samples], rate));
      await app.library.finalize({ id: created.id, durationMs: 4000, hasVideo: false, videoWidth: null, videoHeight: null });
      const original = [{ pitch: 60, startTime: 0.5, endTime: 1.5, velocity: 80 }];
      const edited = [{ pitch: 84, startTime: 0.5, endTime: 1.5, velocity: 80 }];
      await app.library.saveTranscription({ id: created.id, engine: 'test', engineVersion: '1', params: {}, notes: original, summary: summarize(original) });
      await app.library.saveEdits({ id: created.id, notes: edited, summary: summarize(edited) });
      await app.library.setCrop(created.id, 500, 2500);
      await app.library.setRepeats(created.id, 2);
      await app.refresh();
      return created.id;
    });
    const tile = page.locator(`[data-tile="${id}"]`);
    const pixels = {};
    for (const [mode, label] of [['recording', 'Take'], ['notes', 'Notes'], ['both', 'Both']]) {
      await tile.dblclick({ position: { x: 30, y: 40 } });
      await page.waitForSelector('.listen');
      await page.locator('.listen').getByRole('button', { name: label, exact: true }).click();
      await page.waitForFunction(async ({ id, mode }) => {
        const { app } = await import('/src/lib/state/app.svelte.ts');
        return (await app.library.get(id)).listenMode === mode;
      }, { id, mode });
      await page.getByRole('button', { name: 'Back to the notebook' }).click();
      await tile.waitFor({ state: 'visible' });
      await tile.locator(`canvas[data-preview="${mode === 'notes' ? 'notes' : 'waveform'}"]`).waitFor();
      await page.waitForTimeout(300);
      pixels[mode] = await tile.locator('canvas').evaluate((canvas) => {
        const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) count++;
        return count;
      });
      await page.evaluate(() => { window.__sources = []; });
      await page.locator('.controls .play').click();
      await page.waitForFunction(() => window.__sources.length >= 2);
      const timing = await page.evaluate((mode) => {
        window.__heard[mode] = window.__sources[0].buffer;
        return window.__sources.map(({ when, offset, duration }) => ({ when, offset, duration }));
      }, mode);
      assert.equal(timing.length, 2, `${mode}: two repeats`);
      assert(Math.abs(timing[0].offset - 0.5) < 0.001, `${mode}: crop start`);
      assert(Math.abs(timing[0].duration - 2) < 0.001, `${mode}: crop length`);
      assert(Math.abs(timing[1].when - timing[0].when - 2) < 0.001, `${mode}: repeats stay aligned`);
      await page.locator('.controls .play').click();
      // Reopening must read the saved choice, not start again at Take.
      await tile.dblclick({ position: { x: 30, y: 40 } });
      await page.locator(`.listen button[aria-pressed="true"]`).filter({ hasText: label }).waitFor();
      await page.getByRole('button', { name: 'Back to the notebook' }).click();
      await tile.waitFor({ state: 'visible' });
    }
    const signal = await page.evaluate(() => {
      const [take, notes, both] = ['recording', 'notes', 'both'].map((mode) => window.__heard[mode].getChannelData(0));
      let difference = 0, sumError = 0, notePeak = 0;
      for (let i = 0; i < both.length; i++) {
        const t = take[i] ?? 0, n = notes[i] ?? 0;
        difference = Math.max(difference, Math.abs(t - n));
        sumError = Math.max(sumError, Math.abs(both[i] - t - n));
        notePeak = Math.max(notePeak, Math.abs(n));
      }
      return { difference, sumError, notePeak };
    });
    assert(signal.difference > 0.1 && signal.notePeak > 0.01, 'Notes must produce a different, nonzero sound from the take');
    assert(signal.sumError < 0.00001, `Both must contain the sum of Take and Notes: ${JSON.stringify(signal)}`);
    assert(pixels.notes > 0 && pixels.notes < pixels.recording / 2, 'Notes preview must contain piano-roll bars, not the waveform');
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('.toast.error').count(), 0);
    console.log('LISTEN MODE OK', JSON.stringify({ signal, pixels }));
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
