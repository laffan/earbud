/**
 * Notebook canvas check (browser preview, phone width, the ?demo notebook).
 * Every buffer source the page starts is recorded (when, from where in its
 * buffer, for how long), so sound can be checked without listening.
 *
 * - Playing the canvas starts every sketch on one audio clock, each where it
 *   sits on the timeline (a rhythm at its place, a recording from its start).
 * - Tap empty canvas: the playhead goes there. Tap a sketch: it plays on its
 *   own, and the playhead returns when it is stopped.
 * - Hold empty canvas: Record audio / Import audio / Record rhythm.
 * - Record rhythm: keys 1 2 3 tapped as a two-bar rock beat at 100 BPM become
 *   that pattern at that tempo; it is saved as a sketch where the canvas was
 *   held.
 * - Hold a sketch: its menu (Copy, Duplicate, Export, Delete) while held;
 *   moving closes it and drags the sketch. Duplicate puts a copy after it.
 * - Drag a rhythm's right edge: it repeats over more bars; a recording's:
 *   it plays several times in a row, each pass on the same clock.
 * - Export a rhythm (audio and MIDI); copy it and paste it into another
 *   notebook.
 * - Double-tap a rhythm: its editor; a recording: the sketch view.
 * - Repeat, with the minimap's loop handles.
 * - A new notebook, the notebook menu, and back.
 * Fails on any page error or error toast.
 *
 *   npm run dev            # terminal 1
 *   npm run smoke:notebook
 */
const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';
const OUT = process.env.SMOKE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instrument() {
  window.__sources = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration) {
    // One-sample buffers are WebKit's unlock trick, not sound.
    if (this.buffer && this.buffer.length > 1) {
      window.__sources.push({ when, offset, duration: duration ?? null, length: this.buffer.duration, at: this.context.currentTime });
    }
    return start.apply(this, arguments);
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
  const tiles = () =>
    page.$$eval('[data-tile]', (els) => els.map((e) => ({ id: e.dataset.tile, label: e.getAttribute('aria-label'), r: e.getBoundingClientRect().toJSON() })));
  const tile = async (prefix) => (await tiles()).find((t) => t.label.startsWith(prefix));
  const sources = () => page.evaluate(() => window.__sources.slice());
  const time = async () => (await page.textContent('.controls .time')).trim().split(' ')[0];
  const hold = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(650);
    await page.mouse.up();
    await sleep(120);
  };

  await page.goto(`${URL}?demo`);
  await page.waitForSelector('[data-tile]', { timeout: 60000 });
  await sleep(1500);
  const canvas = await page.$eval('.canvas', (e) => e.getBoundingClientRect().toJSON());
  expect((await tiles()).length === 4, 'the demo notebook should show four sketches');
  await shot('01-notebook');

  // Play the canvas from 0: every sketch starts on one clock at its place.
  await page.click('.controls .play');
  await sleep(1200);
  const started = await sources();
  await page.click('.controls .play');
  // Lengths tell the sketches apart: the 16-bar piece (~41.9 s), the rhythm (40 s + ring-out), the later part (~31.9 s).
  const piece = started.find((s) => s.length > 41.5 && s.length < 42.5);
  const rhythm = started.find((s) => s.length > 40.4 && s.length < 40.8);
  const later = started.find((s) => s.length > 31 && s.length < 33);
  console.log('started:', JSON.stringify(started.map((s) => [+s.when.toFixed(3), +s.offset.toFixed(3), +s.length.toFixed(2)])));
  expect(piece && rhythm && later, 'playing the canvas should schedule all three sketches under the timeline');
  if (piece && rhythm && later) {
    // Demo places: the piece's recording at 1.6 s, the rhythm at 2 s, the later part at 11.6 s.
    expect(Math.abs(rhythm.when - piece.when - 0.4) < 0.002, `the rhythm should start 0.4 s after the piece (${(rhythm.when - piece.when).toFixed(4)})`);
    expect(Math.abs(later.when - piece.when - 10) < 0.002, `the later part should start 10 s after the piece (${(later.when - piece.when).toFixed(4)})`);
  }

  // Tap empty canvas: the playhead goes there.
  await page.mouse.click(250, canvas.bottom - 30);
  await sleep(200);
  const tapped = await time();
  expect(tapped !== '0:00.0', `tapping the canvas should move the playhead (${tapped})`);

  // Tap a sketch: it plays alone; tap again: it stops and the playhead returns.
  const piece0 = await tile('Sixteen');
  const before = (await sources()).length;
  await page.mouse.click(piece0.r.x + 40, piece0.r.y + 40);
  await sleep(1200);
  // The others start too, silent: like mute, playing alone only moves their gain.
  const alone = (await sources()).slice(before);
  expect((await page.$$('.tile.soloing')).length === 1, 'a tapped sketch should play on its own');
  expect(
    alone.some((s) => s.length > 41.5 && s.length < 42.5 && s.offset === 0),
    'the tapped sketch should play from its start',
  );
  await page.mouse.click(piece0.r.x + 40, piece0.r.y + 40);
  await sleep(500);
  expect((await page.$$('.tile.soloing')).length === 0, 'a second tap should stop it');
  expect((await time()) === tapped, `the playhead should go back to ${tapped} (${await time()})`);

  // Hold empty canvas: the menu.
  const spot = { x: 300, y: canvas.bottom - 120 };
  await hold(spot.x, spot.y);
  const items = await page.$$eval('.popover [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
  expect(items.join('|') === 'Record audio|Import audio|Record rhythm', `menu items: ${items.join('|')}`);
  await shot('02-menu');

  // Record a rhythm: a two-bar rock beat at 100 BPM, and the closing downbeat.
  await page.click('[role=menuitem]:has-text("Record rhythm")');
  await sleep(300);
  const eighth = 300;
  const t0 = Date.now();
  for (let i = 0; i < 16; i++) {
    while (Date.now() < t0 + i * eighth) await sleep(2);
    if (i % 4 === 0) await page.keyboard.press('1');
    if (i % 4 === 2) await page.keyboard.press('2');
    await page.keyboard.press('3');
  }
  while (Date.now() < t0 + 16 * eighth) await sleep(2);
  await page.keyboard.press('1');
  await sleep(200);
  await page.click('[role=dialog] button:has-text("Done")');
  await sleep(300);
  const grid = await page.$$eval('.row', (rows) => rows.map((r) => [...r.querySelectorAll('.step')].map((s) => (s.classList.contains('on') ? 'x' : '.')).join('')));
  const tempo = (await page.textContent('.stepper .value')).replace(/\D/g, '');
  console.log('tapped pattern:', JSON.stringify(grid), 'tempo', tempo);
  expect(tempo === '100', `the tempo should be 100 (${tempo})`);
  expect(grid[0] === 'x.......x.......x.......x.......', `kick: ${grid[0]}`);
  expect(grid[1] === '....x.......x.......x.......x...', `snare: ${grid[1]}`);
  expect(grid[2] === 'x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.x.', `hat: ${grid[2]}`);
  await shot('03-rhythm');
  await page.fill('.edit-head .title', 'Tapped beat');
  await page.click('[role=dialog] button:has-text("Save")');
  await sleep(600);
  const beat = await tile('Tapped beat');
  expect(beat && Math.abs(beat.r.x - spot.x) < 2, `the rhythm should start where the canvas was held (${beat?.r.x} vs ${spot.x})`);

  // Export a rhythm: its audio and MIDI.
  const tappedBeat = await tile('Tapped beat');
  await hold(tappedBeat.r.x + 8, tappedBeat.r.y + 30);
  await page.click('.popover [role=menuitem]:has-text("Export")');
  await page.waitForSelector('[role=dialog][aria-label^="Export"]');
  const exportOptions = await page.$$eval('.option .label', (els) => els.map((e) => e.textContent.trim()));
  expect(exportOptions.join('|') === 'Audio|MIDI', `rhythm export options: ${exportOptions.join('|')}`);
  for (const box of await page.$$('.option input')) if (!(await box.isChecked())) await box.check();
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await page.click('.actions .primary');
  await sleep(1500);
  expect(downloads.sort().join('|') === 'Tapped beat.mid|Tapped beat.wav', `rhythm downloads: ${downloads.join('|')}`);

  // Copy it, and paste it into another notebook where the canvas is held.
  await hold(tappedBeat.r.x + 8, tappedBeat.r.y + 30);
  await page.click('.popover [role=menuitem]:has-text("Copy")');
  await page.click('.picker .title');
  await page.click('[role=menuitem]:has-text("New notebook")');
  await sleep(300);
  await hold(160, canvas.y + 200);
  await page.click('.popover [role=menuitem]:has-text("Paste")');
  await sleep(500);
  const pasted = await tiles();
  expect(
    pasted.length === 1 && pasted[0].label.startsWith('Tapped beat') && Math.abs(pasted[0].r.x - 160) < 1.5,
    `paste should put the copy where the canvas was held (${JSON.stringify(pasted.map((t) => [t.label, t.r.x]))})`,
  );
  await page.click('.picker .title');
  await page.click('[role=menuitemradio]:has-text("Demo notebook")');
  await sleep(400);

  // Hold a sketch: its menu shows while held; moving closes it and drags the sketch.
  const menuItems = () => page.$$eval('.popover [role=menuitem]', (els) => els.map((e) => e.textContent.trim()));
  const bass = await tile('Bass');
  await page.mouse.move(bass.r.x + 30, bass.r.y + 30);
  await page.mouse.down();
  await sleep(600);
  const whileHeld = await menuItems();
  expect(whileHeld.join('|') === 'Copy|Duplicate|Export|Delete', `sketch menu while held: ${whileHeld.join('|')}`);
  await page.mouse.move(bass.r.x + 80, bass.r.y + 110, { steps: 8 });
  expect((await menuItems()).length === 0, 'dragging should close the menu');
  await page.mouse.up();
  await sleep(300);
  const moved = await tile('Bass');
  expect(Math.round(moved.r.x - bass.r.x) === 50 && Math.round(moved.r.y - bass.r.y) === 80, `dragging should move the sketch (${moved.r.x - bass.r.x}, ${moved.r.y - bass.r.y})`);

  // Hold it and let go: the menu stays. Duplicate: a copy right after it, at the same height.
  await hold(moved.r.x + 30, moved.r.y + 30);
  expect((await menuItems()).join('|') === 'Copy|Duplicate|Export|Delete', 'the menu should stay after letting go');
  await page.click('.popover [role=menuitem]:has-text("Duplicate")');
  await sleep(500);
  const basses = (await tiles()).filter((t) => t.label === 'Bass and tenor').sort((a, b) => a.r.x - b.r.x);
  expect(basses.length === 2, `duplicate should add a copy (${basses.length})`);
  if (basses.length === 2) {
    expect(
      Math.abs(basses[1].r.x - (basses[0].r.x + basses[0].r.width)) < 1.5 && basses[1].r.y === basses[0].r.y,
      'the copy should follow the original at its height',
    );
  }

  // Stretch the demo rhythm by its right edge.
  const backbeat = await tile('Backbeat');
  const grip = await page.$eval(`[data-resize="${backbeat.id}"]`, (e) => e.getBoundingClientRect().toJSON());
  const barPx = backbeat.r.width / 16;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 20);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + barPx * 4, grip.y + 20, { steps: 8 });
  await page.mouse.up();
  await sleep(500);
  const meta = await page.$eval(`[data-tile="${backbeat.id}"] .meta`, (e) => e.textContent);
  expect(meta.includes('20 bars'), `stretching should repeat the rhythm (${meta})`);

  // Stretch a recording by its right edge: it plays twice in a row, the second time one part later on the clock.
  const piece2 = await tile('Sixteen');
  const pieceGrip = await page.$eval(`[data-resize="${piece2.id}"]`, (e) => e.getBoundingClientRect().toJSON());
  await page.mouse.move(pieceGrip.x + pieceGrip.width / 2, pieceGrip.y + 20);
  await page.mouse.down();
  await page.mouse.move(pieceGrip.x + pieceGrip.width / 2 + piece2.r.width, pieceGrip.y + 20, { steps: 8 });
  const repeatBadge = await page.textContent('.badge').catch(() => null);
  await page.mouse.up();
  await sleep(400);
  expect(repeatBadge === '×2', `stretching a recording should show its repeats (${repeatBadge})`);
  const piece3 = await tile('Sixteen');
  expect(Math.abs(piece3.r.width - 2 * piece2.r.width) < 2, `the recording should be twice as wide (${piece2.r.width} → ${piece3.r.width})`);
  const zero = await page.$eval('.tick', (e) => e.getBoundingClientRect().left);
  await page.mouse.click(zero + 1, canvas.bottom - 30);
  const fromHere = (await sources()).length;
  await page.click('.controls .play');
  await sleep(800);
  await page.click('.controls .play');
  const passes = (await sources()).slice(fromHere).filter((x) => x.length > 41.5 && x.length < 42.5);
  expect(passes.length === 2, `the recording should be scheduled twice (${passes.length})`);
  if (passes.length === 2) {
    const gap = passes[1].when - passes[0].when;
    expect(Math.abs(gap - passes[0].length) < 0.002, `its second pass should start one part later (${gap.toFixed(4)} vs ${passes[0].length.toFixed(4)})`);
  }

  // Double-tap: a rhythm opens its editor; a recording opens the sketch.
  const backbeat2 = await tile('Backbeat');
  await page.mouse.dblclick(backbeat2.r.x + 30, backbeat2.r.y + 15);
  await sleep(300);
  expect((await page.getAttribute('[role=dialog]', 'aria-label').catch(() => null)) === 'Edit rhythm', 'double-tapping a rhythm should open its editor');
  await page.click('[role=dialog] button:has-text("Cancel")');
  const piece1 = await tile('Sixteen');
  await page.mouse.dblclick(piece1.r.x + 40, piece1.r.y + 40);
  await page.waitForSelector('.sketch-view', { timeout: 5000 });
  const trackButtons = await page.$$eval('button', (b) => b.filter((x) => /Record track|Import track|Separate/.test(x.textContent)).length);
  expect(trackButtons === 0, 'the sketch view should have no track controls');
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  await sleep(400);

  // Repeat, and a loop range from the minimap's handles.
  await page.click('button[aria-label="Repeat"]');
  await sleep(150);
  const end = await page.$eval('[data-handle=end]', (e) => e.getBoundingClientRect().toJSON());
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2 - 80, end.y + end.height / 2, { steps: 5 });
  await page.mouse.up();
  await sleep(250);
  expect(!!(await page.$('.controls .link')), 'a custom loop range should offer to loop everything again');
  await shot('04-repeat');

  // A new notebook, then back.
  await page.click('.picker .title');
  await page.click('[role=menuitem]:has-text("New notebook")');
  await sleep(300);
  expect((await page.textContent('.picker .name')) === 'Notebook 3', 'a new notebook should open');
  expect((await tiles()).length === 0, 'a new notebook should be empty');
  await page.click('.picker .title');
  await page.click('[role=menuitemradio]:has-text("Demo notebook")');
  await sleep(400);
  expect((await tiles()).length === 6, `back in the demo notebook (${(await tiles()).length} sketches)`);

  const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent)).catch(() => []);
  if (toasts.some((t) => /could not/i.test(t))) problems.push(`toasts: ${toasts.join(' | ')}`);
  await browser.close();
  if (problems.length) {
    console.error(`NOTEBOOK CHECK FAILED:\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log('NOTEBOOK OK');
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
