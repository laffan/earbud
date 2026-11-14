/**
 * Browser end-to-end smoke test of the full sketch workflow, using Chromium's
 * fake camera and a WAV file as the fake microphone:
 *   record → save → transcribe (Basic Pitch) → review → rename → notes →
 *   select/transpose/delete/undo a note → autosave.
 *
 * Runs against the Vite dev server (the in-memory library is used outside
 * Tauri). Requires Playwright with Chromium installed.
 *
 *   npm run dev                                   # terminal 1
 *   node scripts/make-test-audio.mjs /tmp/chords.wav
 *   SMOKE_WAV=/tmp/chords.wav SMOKE_OUT=/tmp/shots node scripts/browser-smoke.cjs
 */
const { chromium } = require('playwright');
const { mkdirSync } = require('node:fs');

const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';
const WAV = process.env.SMOKE_WAV;
const OUT = process.env.SMOKE_OUT ?? 'test-results/smoke';
if (!WAV) throw new Error('Set SMOKE_WAV to a WAV file (see scripts/make-test-audio.mjs)');
mkdirSync(OUT, { recursive: true });

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();
const fail = (message) => {
  throw new Error(message);
};

/** Find the centre of a drawn note on the piano-roll canvas. */
async function findNote(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.roll canvas');
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const scale = width / canvas.getBoundingClientRect().width;
    const data = ctx.getImageData(0, 0, width, height).data;
    const left = Math.ceil(60 * scale);
    const top = Math.ceil(50 * scale);
    for (let y = top; y < height; y += 2) {
      let run = 0;
      for (let x = left; x < width; x++) {
        const i = (y * width + x) * 4;
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        const isNote = b - r > 30 && r < 170;
        run = isNote ? run + 1 : 0;
        if (run > 20 * scale) {
          const rect = canvas.getBoundingClientRect();
          return { x: rect.left + (x - run / 2) / scale, y: rect.top + y / scale };
        }
      }
    }
    return null;
  });
}

(async () => {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'microphone'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /svelte/.test(m.text())) errors.push(m.text());
  });

  await page.goto(URL);
  await page.waitForSelector('text=An empty page.');
  await shot(page, '01-home-empty');

  // Capture.
  await page.click('button[aria-label="Record a new sketch"]');
  await page.waitForSelector('button[aria-label="Stop and save"]:not([disabled])', { timeout: 15000 });
  await page.waitForTimeout(7600);
  await shot(page, '02-recording');
  await page.click('button[aria-label="Stop and save"]');
  await page.waitForSelector('.card', { timeout: 15000 });

  // Transcription runs in the background.
  const started = Date.now();
  await page.waitForFunction(
    () => {
      const card = document.querySelector('.card');
      return card && (card.querySelector('.chords') || /failed/i.test(card.textContent));
    },
    null,
    { timeout: 240000 },
  );
  const card = await text(page, '.card');
  console.log(`transcribed in ${((Date.now() - started) / 1000).toFixed(1)} s: ${card}`);
  if (!card.includes('C – Am – F – G7')) fail(`unexpected chords: ${card}`);
  await shot(page, '03-home-transcribed');

  // Review.
  await page.click('.card');
  await page.waitForSelector('.roll canvas');
  await page.waitForTimeout(800);
  // Phone layout: nothing wider than the screen; the video fits the width.
  const layout = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    video: document.querySelector('video')?.getBoundingClientRect().width ?? 0,
    order: [...document.querySelectorAll('.content > section')].map((e) => e.getAttribute('aria-label')).join(' > '),
  }));
  console.log(`layout: ${JSON.stringify(layout)}`);
  if (layout.page > layout.viewport) fail(`page scrolls sideways (${layout.page} > ${layout.viewport})`);
  if (layout.video === 0 || layout.video > layout.viewport) fail(`video does not fit the width (${layout.video})`);
  if (!layout.order.startsWith('Tracks > Recording')) fail(`unexpected order ${layout.order}`);
  // The transport stays at the bottom of the screen.
  const bar = await page.$eval('.transport-bar', (e) => e.getBoundingClientRect().bottom);
  if (Math.abs(bar - 844) > 1) fail(`transport is not at the bottom (${bar})`);

  await page.click('button[aria-label="Play"]');
  await page.waitForTimeout(2000);
  const time = await text(page, '.time');
  if (time.startsWith('0:00')) fail(`playback did not advance (${time})`);
  await page.click('button[aria-label="Pause"]');
  await shot(page, '04-sketch');

  // Title and notes.
  await page.fill('.title-input', 'Morning chords');
  await page.press('.title-input', 'Enter');
  await page.fill('textarea', 'Try the G7 voicing an octave lower.');
  await page.waitForTimeout(900);

  // Edit: select a note, transpose, delete, undo.
  const countNotes = async () => Number((await text(page, '.details')).match(/Notes(\d+)/)[1]);
  const before = await countNotes();
  await page.click('button[aria-label="Edit notes"]');
  await page.waitForTimeout(300);
  const note = await findNote(page);
  if (!note) fail('no note found on the piano roll');
  await page.mouse.click(note.x, note.y);
  if (await page.isDisabled('button[aria-label="Delete selected notes"]')) fail('tapping a note did not select it');
  await page.keyboard.press('ArrowUp');
  await page.click('button[aria-label="Delete selected notes"]');
  if ((await countNotes()) !== before - 1) fail('delete did not remove a note');
  await page.click('button[aria-label="Undo"]');
  if ((await countNotes()) !== before) fail('undo did not restore the note');
  await page.waitForSelector('.save-state:has-text("Saved")', { timeout: 5000 });
  await shot(page, '05-editing');
  await page.click('button[aria-label="Done editing notes"]');

  await page.click('button[aria-label="Back to sketches"]');
  await page.waitForTimeout(500);
  const after = await text(page, '.card');
  console.log(`card after editing: ${after}`);
  if (!after.includes('Morning chords') || !after.includes('Edited')) fail('edits were not reflected in the library');
  await shot(page, '06-home-after');

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.card');
  await page.waitForTimeout(1000);
  await shot(page, '07-desktop');

  await browser.close();
  if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
  console.log('SMOKE OK');
})().catch((error) => {
  console.error('SMOKE FAILED:', error.message);
  process.exit(1);
});
