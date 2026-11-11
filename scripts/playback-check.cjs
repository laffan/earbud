/**
 * Playback regression check (browser preview with the ?demo sketch, phone
 * width): scrub the waveform then play (playhead must move, display in sync
 * with the media), crop with the waveform handles, stop at the crop end,
 * loop, clear the crop. Fails on any page error or error toast.
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
(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await page.goto(`${URL}?demo`);
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.click('.front');
  await page.waitForSelector('.waveform canvas');
  await page.waitForTimeout(1200);

  const media = () =>
    page.evaluate(() => {
      const v = document.querySelector('video');
      return { t: v.currentTime, paused: v.paused, duration: v.duration };
    });
  const shown = async () => parse(await page.textContent('.time'));
  const playLabel = () => page.getAttribute('.play', 'aria-label');

  // 1. Scrub across the waveform (drag 20% -> 60%).
  const wf = await (await page.$('.waveform canvas')).boundingBox();
  const y = wf.y + wf.height / 2;
  await page.mouse.move(wf.x + wf.width * 0.2, y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(wf.x + wf.width * (0.2 + (0.4 * i) / 20), y);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterScrub = { shown: await shown(), media: await media() };
  console.log('after scrub:', JSON.stringify(afterScrub));

  // 2. Play after scrubbing: playhead moves and stays in sync with the media.
  await page.click('.play');
  await page.waitForTimeout(2000);
  const playing = { shown: await shown(), media: await media(), label: await playLabel() };
  console.log('after 2 s of play:', JSON.stringify(playing));
  if (playing.media.paused || playing.label !== 'Pause') problems.push('not playing after scrub + play');
  if (playing.media.t - afterScrub.media.t < 1.5) problems.push('media did not advance');
  if (Math.abs(playing.shown - Math.floor(playing.media.t)) > 1) problems.push('display out of sync with media');
  await page.click('.play');
  await page.waitForTimeout(200);

  // 3. Crop with the handles: start to 25%, end to 40%.
  const startHandle = await (await page.$('.handle.start')).boundingBox();
  await page.mouse.move(startHandle.x + startHandle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(wf.x + wf.width * 0.25, y, { steps: 6 });
  await page.mouse.up();
  const endHandle = await (await page.$('.handle.end')).boundingBox();
  await page.mouse.move(endHandle.x + endHandle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(wf.x + wf.width * 0.4, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('crop info:', (await page.textContent('.crop-info')).replace(/\s+/g, ' ').trim());
  console.log('position after crop:', await shown(), JSON.stringify(await media()));
  if (OUT) await page.screenshot({ path: `${OUT}/cropped.png` });

  // 4. Play to the end of the crop: stops and returns to the crop start.
  const cropStart = await page.$eval('.handle.start', (e) => Number(e.getAttribute('aria-valuenow')));
  await page.click('.play');
  await page.waitForTimeout(7500);
  const stopped = { shown: await shown(), media: await media(), label: await playLabel() };
  console.log('after playing past the crop end:', JSON.stringify(stopped), 'cropStart', cropStart);
  if (!stopped.media.paused) problems.push('did not stop at crop end');

  // 5. Loop.
  await page.click('button[aria-label="Loop"]');
  await page.click('.play');
  await page.waitForTimeout(8000);
  const looping = { shown: await shown(), media: await media(), label: await playLabel() };
  console.log('looping after 8 s:', JSON.stringify(looping));
  if (looping.media.paused) problems.push('loop stopped');
  await page.click('.play');

  // 6. Clear the crop.
  await page.click('.crop-info .link');
  await page.waitForTimeout(200);
  console.log('crop cleared:', (await page.$('.crop-info')) === null);

  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
  console.log('toasts:', JSON.stringify(toasts));
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
