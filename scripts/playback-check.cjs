/**
 * Playback regression check (browser preview, phone width), against the Web
 * Audio engine. Every buffer source the page starts is recorded (when, from
 * where in its buffer), so sound can be checked without listening.
 *
 * The ?demo notebook's "Sixteen bars" sketch, opened from the canvas: scrub
 * the waveform then play (playhead moves and matches the audio clock), crop
 * with the waveform handles, stop at the crop end, loop without a gap, clear
 * the crop. (Several sketches playing together on one clock is checked on
 * the canvas by `npm run smoke:notebook`.)
 * Fails on any page error or error toast.
 *
 *   npm run dev            # terminal 1
 *   npm run smoke:playback
 */
const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';
const OUT = process.env.SMOKE_OUT;
const parse = (text) => {
  const [m, s] = text.trim().split('/')[0].trim().split(':').map(Number);
  return m * 60 + s;
};

/** Record buffer sources and synth notes, and keep hold of the audio contexts. */
function instrument() {
  window.__sources = [];
  window.__notes = 0;
  window.__contexts = [];
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...args) {
      super(...args);
      window.__contexts.push(this);
    }
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0) {
    // One-sample buffers are WebKit's unlock trick, not sound.
    if (this.buffer && this.buffer.length > 1 && this.context instanceof window.AudioContext) {
      const record = { when, offset, duration: this.buffer.duration, stoppedAt: null };
      const stop = this.stop;
      this.stop = function (at = 0) {
        record.stoppedAt = record.stoppedAt === null ? at : Math.min(record.stoppedAt, at);
        return stop.apply(this, arguments);
      };
      window.__sources.push(record);
    }
    return start.apply(this, arguments);
  };
  const oscStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function () {
    if (this.type === 'triangle' && this.context instanceof window.AudioContext) window.__notes++;
    return oscStart.apply(this, arguments);
  };
}

/** Open the demo notebook's 16-bar sketch (double-tap its tile on the canvas). */
async function openSketch(page) {
  await page.goto(`${URL}?demo`);
  const tile = page.locator('[data-tile][aria-label="Sixteen bars"]');
  await tile.waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  await tile.dblclick({ position: { x: 30, y: 40 } });
  await page.waitForSelector('.waveform canvas');
  await page.waitForTimeout(1200);
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.addInitScript(instrument);
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  const shown = async () => parse(await page.textContent('.time'));
  const playLabel = () => page.getAttribute('.play', 'aria-label');
  const sources = () => page.evaluate(() => window.__sources.slice());
  /** Where the audio is (timeline seconds), from the last source started for the first track. */
  const audioAt = () =>
    page.evaluate(() => {
      const ctx = window.__contexts[window.__contexts.length - 1];
      const s = window.__sources[window.__sources.length - 1];
      return s ? s.offset + (ctx.currentTime - s.when) : null;
    });

  await openSketch(page);
  const wfEl = await page.$('.waveform canvas');
  const wf = await wfEl.boundingBox();
  const y = wf.y + wf.height / 2;

  // 1. Scrub across the waveform (20% -> 60%), then play: the playhead moves with the audio.
  await page.mouse.move(wf.x + wf.width * 0.2, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(wf.x + wf.width * (0.2 + (0.4 * i) / 20), y);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterScrub = await shown();
  await page.click('.play');
  await page.waitForTimeout(2000);
  const played = { shown: await shown(), audio: await audioAt(), label: await playLabel() };
  console.log('after scrub to', afterScrub, 's and 2 s of play:', JSON.stringify(played));
  const first = (await sources())[0];
  if (!first) problems.push('no sound started');
  else if (Math.abs(first.offset - afterScrub) > 1) problems.push(`started at ${first.offset}, not at the scrub position`);
  if (played.label !== 'Pause') problems.push('not playing after scrub + play');
  if (played.audio === null || Math.abs(played.shown - Math.floor(played.audio)) > 1) problems.push('display out of step with the audio');
  await page.click('.play');
  await page.waitForTimeout(200);

  // 2. Crop with the handles: start to 25%, end to 40%.
  for (const [handle, to] of [
    ['.handle.start', 0.25],
    ['.handle.end', 0.4],
  ]) {
    const box = await (await page.$(handle)).boundingBox();
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(wf.x + wf.width * to, y, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
  console.log('crop info:', (await page.textContent('.crop-info')).replace(/\s+/g, ' ').trim());
  if (OUT) await page.screenshot({ path: `${OUT}/cropped.png` });

  // 3. Play to the end of the crop: stops exactly there and returns to the crop start.
  const cropStart = await page.$eval('.handle.start', (e) => Number(e.getAttribute('aria-valuenow')));
  const cropEnd = await page.$eval('.handle.end', (e) => Number(e.getAttribute('aria-valuenow')));
  const before = (await sources()).length;
  await page.click('.play');
  await page.waitForTimeout((cropEnd - cropStart) * 1000 + 1500);
  const stopped = { shown: await shown(), label: await playLabel() };
  const pass = (await sources())[before];
  console.log('after playing past the crop end:', JSON.stringify(stopped), JSON.stringify(pass));
  if (stopped.label !== 'Play') problems.push('did not stop at the crop end');
  if (Math.abs(stopped.shown - cropStart) > 1) problems.push('did not return to the crop start');
  if (!pass || pass.stoppedAt === null) problems.push('the sound was not stopped at the crop end');

  // 4. Loop: each pass starts exactly where the previous one stops.
  await page.click('button[aria-label="Loop"]');
  const loopFrom = (await sources()).length;
  await page.click('.play');
  await page.waitForTimeout((cropEnd - cropStart) * 2000 + 1500);
  const passes = (await sources()).slice(loopFrom);
  console.log('loop passes:', JSON.stringify(passes.map((p) => [+p.when.toFixed(3), +p.offset.toFixed(2), p.stoppedAt && +p.stoppedAt.toFixed(3)])));
  if ((await playLabel()) !== 'Pause') problems.push('loop stopped');
  if (passes.length < 3) problems.push(`expected at least 3 loop passes, got ${passes.length}`);
  for (let i = 1; i < passes.length; i++) {
    if (Math.abs(passes[i].offset - passes[0].offset) > 0.01) problems.push('a loop pass did not start at the crop start');
    if (passes[i - 1].stoppedAt === null || passes[i - 1].stoppedAt - passes[i].when > 0.05 || passes[i].when < passes[i - 1].stoppedAt - 0.05)
      problems.push(`gap or overlap between loop passes ${i - 1} and ${i}`);
  }
  await page.click('.play');
  await page.click('button[aria-label="Loop"]');

  // 5. Clear the crop.
  await page.click('.crop-info .link');
  await page.waitForTimeout(200);
  if (await page.$('.crop-info')) problems.push('crop not cleared');

  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
  if (toasts.length) problems.push(`toasts: ${toasts.join(' | ')}`);
  await browser.close();
  if (problems.length) {
    console.error(`PLAYBACK CHECK FAILED:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('PLAYBACK OK');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
