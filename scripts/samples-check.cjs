/**
 * Check of the space bar, audio renewal, the always-editing piano roll, the
 * sample library and the rhythm view (browser preview, the ?demo notebook,
 * phone width). Every buffer source and oscillator the page starts is
 * recorded, so sound can be checked without listening.
 *
 * - The space bar plays and pauses the canvas, also right after its play
 *   button was clicked (which used to toggle twice); not while typing.
 * - After the page was hidden, the next play makes a fresh audio context
 *   (the old one may be stuck in WebKit) and sound starts in it.
 * - The sketch view's roll is editing without a pencil; moving a selected
 *   note plays it. Space plays the sketch.
 * - Ctrl + drag on the waveform selects a passage with an "Add to library"
 *   tooltip, which adds it; a 2 s hold selects too.
 * - The track menu's "Use sample…" makes the notes play with the sample
 *   (Notes), resampled from its root.
 * - The library: a tile per sample, tap plays it, hold opens its menu and
 *   the editor (settings saved, play renders them).
 * - The rhythm view: four pads, the bars side by side, the space bar plays;
 *   a pad can play the sample.
 * - Reference: a guitar shape plays the recorded guitar.
 * - Pinch zoom (ctrl + wheel) never zooms the page.
 * Fails on any page error or error toast.
 *
 *   npm run dev            # terminal 1
 *   npm run smoke:samples
 */
const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';
const OUT = process.env.SMOKE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instrument() {
  window.__sources = [];
  window.__oscillators = 0;
  window.__contexts = [];
  const Ctx = window.AudioContext;
  window.AudioContext = class extends Ctx {
    constructor(...args) {
      super(...args);
      window.__contexts.push(this);
    }
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
    // One-sample buffers are WebKit's unlock trick, not sound.
    if (this.buffer && this.buffer.length > 1) {
      window.__sources.push({
        when,
        length: this.buffer.duration,
        rate: this.playbackRate.value,
        context: window.__contexts.indexOf(this.context),
        at: this.context.currentTime,
      });
    }
    return start.apply(this, arguments);
  };
  const oscStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) {
    window.__oscillators++;
    return oscStart.apply(this, args);
  };
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.addInitScript(instrument);
  const problems = [];
  const expect = (ok, message) => {
    if (!ok) problems.push(message);
  };
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  const shot = (name) => (OUT ? page.screenshot({ path: `${OUT}/${name}.png` }) : null);
  // What is heard: sources in real-time contexts (offline renderings of samples and rhythms are left out).
  const sources = () => page.evaluate(() => window.__sources.filter((s) => s.context >= 0));
  const errorToast = async () => page.$$eval('.toast.error, [role="alert"]', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
  const label = (selector) => page.getAttribute(selector, 'aria-label');

  await page.goto(`${URL}?demo`);
  await page.waitForSelector('[data-tile][aria-label^="Sixteen bars"]', { timeout: 30000 });
  await sleep(1500);

  // ------------------------------------------------------------ space bar
  const playButton = '.controls .play';
  expect((await label(playButton)) === 'Play', 'canvas starts paused');
  await page.keyboard.press('Space');
  await sleep(400);
  expect((await label(playButton)) === 'Pause', 'space plays the canvas');
  await page.click(playButton);
  await sleep(300);
  expect((await label(playButton)) === 'Play', 'the play button pauses');
  // The button now has focus: space must toggle once, not twice.
  await page.keyboard.press('Space');
  await sleep(400);
  expect((await label(playButton)) === 'Pause', `space after clicking play plays once (got ${await label(playButton)})`);
  await page.keyboard.press('Space');
  await sleep(300);
  expect((await label(playButton)) === 'Play', 'space pauses again');

  // --------------------------------------------- back from the background
  const contextsBefore = await page.evaluate(() => window.__contexts.length);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const sourcesBefore = (await sources()).length;
  await page.click(playButton);
  await sleep(800);
  const contextsAfter = await page.evaluate(() => window.__contexts.map((c) => c.state));
  expect(contextsAfter.length === contextsBefore + 1, `a fresh context after the page was hidden (${contextsBefore} → ${contextsAfter.length})`);
  expect(contextsAfter[contextsAfter.length - 1] === 'running', 'the fresh context runs');
  const fresh = (await sources()).slice(sourcesBefore);
  expect(fresh.length > 0 && fresh.every((s) => s.context === contextsAfter.length - 1), 'sound starts in the fresh context');
  await page.click(playButton);
  await sleep(200);

  // ------------------------------------------------------- the sketch view
  const tile = page.locator('[data-tile][aria-label^="Sixteen bars"]');
  await tile.dblclick({ position: { x: 30, y: 40 } });
  await page.waitForSelector('.roll canvas');
  await page.waitForSelector('.edit-toolbar');
  expect((await page.$('button[aria-label="Edit notes"]')) === null, 'no pencil: the roll is always editing');
  await sleep(1200);
  await page.keyboard.press('Space');
  await sleep(500);
  expect((await label('.transport .play')) === 'Pause', 'space plays the sketch');
  await page.keyboard.press('Space');
  await sleep(300);
  expect((await label('.transport .play')) === 'Play', 'space pauses the sketch');

  // Moving a selected note plays it.
  const roll = await (await page.$('.roll canvas')).boundingBox();
  const note = await page.evaluate(({ x, y, w, h }) => {
    const canvas = document.querySelector('.roll canvas');
    const g = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    const accentish = (i) => data[i + 2] > 80 && data[i] < 120; // the note colour is a blue
    for (let py = Math.round(30 * dpr); py < canvas.height - 10; py += 2) {
      for (let px = Math.round(60 * dpr); px < canvas.width - 10; px += 2) {
        if (accentish((py * canvas.width + px) * 4)) return { x: x + px / dpr + 2, y: y + py / dpr + 1 };
      }
    }
    return null;
  }, roll);
  expect(!!note, 'a note on the roll');
  if (note) {
    await page.mouse.click(note.x, note.y);
    await sleep(200);
    const before = await page.evaluate(() => window.__oscillators);
    await page.keyboard.press('ArrowUp');
    await sleep(200);
    const after = await page.evaluate(() => window.__oscillators);
    expect(after > before, `moving a selected note plays it (${after - before} oscillators)`);
    await page.click('button[aria-label="Undo"]');
  }

  // Ctrl + drag on the waveform: a passage with "Add to library".
  const wave = await (await page.$('.waveform canvas')).boundingBox();
  const at = (f) => wave.x + wave.width * f;
  const mid = wave.y + wave.height / 2;
  await page.keyboard.down('Control');
  await page.mouse.move(at(0.3), mid);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(at(0.3 + (0.12 * i) / 8), mid);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await page.waitForSelector('.sample-tip', { timeout: 3000 }).catch(() => {});
  expect(!!(await page.$('.sample-tip button:has-text("Add to library")')), 'Ctrl + drag selects a passage with an Add to library tooltip');
  await shot('01-selection');
  await page.click('.sample-tip button:has-text("Add to library")');
  await page.waitForSelector('.sample-tip', { state: 'detached', timeout: 5000 }).catch(() => {});
  await sleep(500);
  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
  expect(toasts.some((t) => t.includes('to the library')), `a toast says it was added (${JSON.stringify(toasts)})`);

  // A 2 s hold selects too; Esc lets it go.
  await page.mouse.move(at(0.6), mid);
  await page.mouse.down();
  await sleep(2300);
  await page.mouse.up();
  await sleep(200);
  expect(!!(await page.$('.sample-tip')), 'a 2 s hold selects a passage');
  await page.keyboard.press('Escape');
  await sleep(150);
  expect(!(await page.$('.sample-tip')), 'Esc lets the selection go');

  // Use sample: the notes play with it.
  await page.click('button[aria-label="Recording actions"]');
  await page.click('button[role="menuitem"]:has-text("Use sample")');
  await page.waitForSelector('.sample-choices');
  await page.click('.sample-choices li:nth-child(2) .choice');
  await sleep(600);
  expect((await page.textContent('.transport .listen button[aria-pressed="true"]')).trim() === 'Notes', 'choosing a sample plays the notes');
  const beforeNotes = (await sources()).length;
  await page.click('.transport .play');
  await sleep(1500);
  await page.click('.transport .play');
  const sampled = (await sources()).slice(beforeNotes).filter((s) => s.length < 10);
  expect(sampled.length > 0 && sampled.some((s) => Math.abs(s.rate - 1) > 0.01), `notes play the sample at other rates (${sampled.length} voices)`);

  // ------------------------------------------------------------ the library
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  await page.click('button[aria-label="Sample library"]');
  await page.waitForSelector('.grid .tile');
  expect((await page.$$('.grid .tile')).length === 1, 'the library shows the sample');
  await shot('02-library');
  const tileBox = await (await page.$('.grid .tile')).boundingBox();
  const beforeTap = (await sources()).length;
  await page.mouse.click(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
  await sleep(700);
  expect((await sources()).length > beforeTap, 'tapping a sample plays it');
  // Hold: its menu, then the editor.
  await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + 20);
  await page.mouse.down();
  await sleep(700);
  await page.mouse.up();
  await page.waitForSelector('.popover button:has-text("Edit sample")');
  await page.click('.popover button:has-text("Edit sample")');
  await page.waitForSelector('.editor');
  await page.$eval('.editor input[aria-label="Tone (high cut)"]', (el) => {
    el.value = '40';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const reverb = await page.$('.editor label.row:has-text("Reverb") input[type="range"]');
  await reverb.evaluate((el) => {
    el.value = '35';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(700);
  const beforeEdit = (await sources()).length;
  await page.click('.editor .play');
  await sleep(800);
  const edited = (await sources()).slice(beforeEdit);
  expect(edited.length === 1, `the editor plays the sample (${JSON.stringify(edited)})`);
  await shot('03-editor');
  await page.click('.editor button[aria-label="Back to the samples"]');
  const settings = await page.evaluate(async () => {
    const { app } = await import('/src/lib/state/app.svelte.ts');
    return app.samples[0].settings;
  });
  expect(settings.reverb === 0.35 && typeof settings.lowpassHz === 'number', `the editor saved its settings (${JSON.stringify(settings)})`);

  // ------------------------------------------------------------- the rhythm
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  const rhythm = page.locator('[data-tile][aria-label^="Backbeat"]');
  await rhythm.dblclick({ position: { x: 30, y: 40 } });
  await page.waitForSelector('.rhythm-view');
  expect((await page.$$('.pads .pad')).length === 4, 'four pads');
  const panels = await page.$$('.carousel .bar-panel');
  expect(panels.length >= 1, `the bars side by side (${panels.length})`);
  await page.keyboard.press('Space');
  await sleep(500);
  expect((await label('.transport .play')) === 'Stop', 'space plays the rhythm');
  await page.keyboard.press('Space');
  await sleep(200);
  await page.click('.pads .pad-3', { force: true });
  await page.click('.sound-button');
  await page.waitForSelector('.choices');
  await page.click('.choices li:nth-child(2) .choice');
  await sleep(400);
  const padSound = (await page.textContent('.pads .pad-3 .pad-sound')).trim();
  expect(padSound !== 'Clap', `Beat 4 plays the sample (${padSound})`);
  await shot('04-rhythm');

  // ----------------------------------------------------------- page zoom
  const zoomBlocked = await page.evaluate(() => {
    const e = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, cancelable: true, bubbles: true });
    document.querySelector('.settings').dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(zoomBlocked, 'ctrl + wheel (a trackpad pinch) does not zoom the page');

  // -------------------------------------------------------------- guitar
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  await page.click('button[aria-label^="Reference"]');
  await page.click('.segmented[aria-label="Instrument"] button:has-text("Guitar")');
  await sleep(1500);
  const beforeGuitar = (await sources()).length;
  await page.click('.card .shape >> nth=0');
  await sleep(500);
  const strum = (await sources()).slice(beforeGuitar);
  expect(strum.length >= 4 && strum.every((s) => s.length > 2 && s.length < 3), `a guitar shape plays recorded guitar notes (${strum.length})`);
  expect(strum.length < 2 || strum[1].when > strum[0].when, 'strummed, one string after another');

  const errors = await errorToast();
  for (const e of errors) problems.push(`toast: ${e}`);
  await browser.close();
  if (problems.length) {
    console.error('SAMPLES CHECK FAILED\n' + problems.map((p) => ` - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('SAMPLES OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
