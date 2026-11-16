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
 * - Hold a sketch: its menu (volume, Copy, Duplicate, Slice, Export, Delete)
 *   while held; moving closes it and drags the sketch. Duplicate puts a copy
 *   after it. Volume below 100 % shows a bar on the sketch's left and lowers
 *   its gain. Slice cuts a recording in two halves that play on, back to back;
 *   Delete removes a sketch after asking.
 * - Drag a rhythm's right edge: it repeats over more bars; a recording's:
 *   it plays several times in a row, each pass on the same clock.
 * - Export a rhythm (audio and MIDI); copy it and paste it into another
 *   notebook.
 * - Double-tap a rhythm: its editor; a recording: the sketch view.
 * - Repeat: only the loop plays (the playhead goes to its start); its edges
 *   move from the ruler and the minimap and run down the canvas as dashed lines.
 * - Reference: every chord of a root on one page (all guitar shapes), and
 *   chords tapped on the circle of fifths recorded as a new sketch.
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
  const parseClock = (text) => {
    const [m, sec] = text.split(':');
    return Number(m) * 60 + Number(sec);
  };
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
  expect(whileHeld.join('|') === 'Copy|Duplicate|Slice|Export|Delete', `sketch menu while held: ${whileHeld.join('|')}`);
  await page.mouse.move(bass.r.x + 80, bass.r.y + 110, { steps: 8 });
  expect((await menuItems()).length === 0, 'dragging should close the menu');
  await page.mouse.up();
  await sleep(300);
  const moved = await tile('Bass');
  expect(Math.round(moved.r.x - bass.r.x) === 50 && Math.round(moved.r.y - bass.r.y) === 80, `dragging should move the sketch (${moved.r.x - bass.r.x}, ${moved.r.y - bass.r.y})`);

  // Hold it and let go: the menu stays. Duplicate: a copy right after it, at the same height.
  await hold(moved.r.x + 30, moved.r.y + 30);
  expect((await menuItems()).join('|') === 'Copy|Duplicate|Slice|Export|Delete', 'the menu should stay after letting go');
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

  // Volume: the slider in the menu; under 100 % a bar on the sketch's left, and its gain follows.
  const copyBass = basses[1];
  await hold(copyBass.r.x + 30, copyBass.r.y + 30);
  await page.$eval('.popover input[type=range]', (el) => {
    el.value = '35';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(400);
  expect((await page.textContent('.popover .vol-value')).trim() === '35%', 'the menu should show the volume');
  const bars = await page.$$eval('.volume', (els) => els.map((e) => e.getAttribute('title')));
  expect(bars.length === 1 && bars[0] === 'Volume 35%', `a quieter sketch should show its volume (${JSON.stringify(bars)})`);
  await page.keyboard.press('Escape');

  // Slice the copy: two sketches, back to back, together as long as it was.
  await hold(copyBass.r.x + copyBass.r.width * 0.4, copyBass.r.y + 30);
  await page.click('.popover [role=menuitem]:has-text("Slice")');
  await page.waitForSelector('.slice-bar');
  await page.mouse.move(copyBass.r.x + copyBass.r.width * 0.4, copyBass.r.y + 40);
  await page.mouse.down();
  await page.mouse.move(copyBass.r.x + copyBass.r.width * 0.5, copyBass.r.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.click('.slice-bar button:has-text("Slice")');
  await sleep(800);
  // (The original sits just before the copy, at the same height.)
  const halves = (await tiles())
    .filter((t) => t.label.startsWith('Bass and tenor') && Math.abs(t.r.y - copyBass.r.y) < 1 && t.r.x > copyBass.r.x - 1)
    .sort((a, b) => a.r.x - b.r.x);
  expect(halves.length === 2, `slicing should make two sketches (${halves.length})`);
  if (halves.length === 2) {
    expect(halves[1].label === 'Bass and tenor (2)', `the second half's title (${halves[1].label})`);
    expect(Math.abs(halves[0].r.x + halves[0].r.width - halves[1].r.x) < 1.5, 'the halves should sit back to back');
    expect(Math.abs(halves[1].r.x + halves[1].r.width - (copyBass.r.x + copyBass.r.width)) < 1.5, 'the halves should end where the sketch did');
    expect(Math.abs(halves[0].r.width - copyBass.r.width / 2) < 3, `the cut should be where it was dragged (${halves[0].r.width} of ${copyBass.r.width})`);
  }
  // Delete the second half from its menu (after asking).
  if (halves.length === 2) {
    await hold(halves[1].r.x + 20, halves[1].r.y + 30);
    await page.click('.popover [role=menuitem]:has-text("Delete")');
    await page.waitForSelector('.sheet');
    await page.click('.sheet .pill-button.danger');
    await sleep(500);
    expect(!(await tiles()).some((t) => t.label === 'Bass and tenor (2)'), 'Delete in the menu should delete the sketch');
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
  // The rhythm view: tap a step on, drag another's velocity down; the canvas tile follows.
  expect(!!(await page.$('.rhythm-view')), 'double-tapping a rhythm should open the rhythm view');
  const stepLevels = () =>
    page.$$eval('.steps .step', (els) => els.map((e) => (e.classList.contains('on') ? Math.round(parseFloat(e.querySelector('.fill').style.height)) : 0)));
  const stepButtons = await page.$$('.steps .step');
  await stepButtons[2].click();
  const first = await stepButtons[0].boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 64, { steps: 6 });
  await page.mouse.up();
  const levels = await stepLevels();
  expect(levels[0] === 60 && levels[2] === 80, `a tap and a velocity drag (${JSON.stringify(levels.slice(0, 4))})`);
  await page.click('button[aria-label="Undo"]');
  expect((await stepLevels())[0] === 100, 'undo should restore the velocity');
  await sleep(700);
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  await sleep(400);
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
  // Only the loop plays: the playhead moves to its start (the first sketch), and taps outside stay in it.
  const loopStartTime = await time();
  expect(loopStartTime !== '0:00.0', `repeat should put the playhead at the loop's start (${loopStartTime})`);
  const end = await page.$eval('[data-handle=end]', (e) => e.getBoundingClientRect().toJSON());
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2 - 80, end.y + end.height / 2, { steps: 5 });
  await page.mouse.up();
  await sleep(250);
  expect(!!(await page.$('.controls .link')), 'a custom loop range should offer to loop everything again');
  // The loop's start, dragged on the ruler.
  const rulerStart = await page.$eval('.ruler-handle.start', (e) => e.getBoundingClientRect().toJSON());
  const startBefore = Number(await page.getAttribute('.ruler-handle.start', 'aria-valuenow'));
  await page.mouse.move(rulerStart.x + rulerStart.width / 2, rulerStart.y + 10);
  await page.mouse.down();
  await page.mouse.move(rulerStart.x + rulerStart.width / 2 + 60, rulerStart.y + 10, { steps: 5 });
  await page.mouse.up();
  await sleep(250);
  const startAfter = Number(await page.getAttribute('.ruler-handle.start', 'aria-valuenow'));
  expect(startAfter > startBefore + 0.5, `the ruler's handle should move the loop's start (${startBefore} → ${startAfter})`);
  expect(Math.abs(parseClock(await time()) - startAfter) < 0.15, `the playhead should stay in the loop (${await time()}, loop from ${startAfter})`);
  const edges = await page.$$eval('.loop-edge', (els) => els.map((e) => e.getBoundingClientRect().height));
  expect(edges.length >= 1 && edges.every((h) => h > canvas.height * 0.8), `the loop's edges should run down the canvas (${JSON.stringify(edges)})`);
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

  // Text notes: double-tap empty canvas to write one (markdown); the playhead stays where it was.
  const notes = () =>
    page.$$eval('.note[data-tile]', (els) =>
      els.map((e) => ({ id: e.dataset.tile, html: e.querySelector('.md')?.innerHTML ?? '', font: getComputedStyle(e).fontSize, r: e.getBoundingClientRect().toJSON() })),
    );
  const playheadBefore = await time();
  await page.mouse.dblclick(40, canvas.bottom - 160);
  await page.waitForSelector('.note textarea');
  await page.keyboard.type('**Bridge** in *D minor*\n- [ ] left hand');
  await page.mouse.click(300, canvas.y + 60);
  await sleep(300);
  const written = await notes();
  expect(written.length === 1 && written[0].html.includes('<strong>Bridge</strong>') && written[0].html.includes('<ul>'), `a markdown note (${JSON.stringify(written.map((n) => n.html))})`);
  expect((await time()) === playheadBefore, `a double tap should leave the playhead (${playheadBefore} → ${await time()})`);
  // Resize it by its corner.
  const corner = await page.$eval(`[data-resize="${written[0].id}"]`, (e) => e.getBoundingClientRect().toJSON());
  await page.mouse.move(corner.x + 9, corner.y + 9);
  await page.mouse.down();
  await page.mouse.move(corner.x + 69, corner.y + 9, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  const wider = (await notes())[0];
  expect(Math.round(wider.r.width - written[0].r.width) === 60, `the corner should resize the note (${written[0].r.width} → ${wider.r.width})`);
  // Only an emoji: shown at 50 px.
  await page.mouse.dblclick(40, canvas.bottom - 50);
  await page.waitForSelector('.note textarea');
  await page.keyboard.type('🔥');
  await page.keyboard.press('Escape');
  await sleep(300);
  const fire = (await notes()).find((n) => n.html === '<p>🔥</p>');
  expect(fire && fire.font === '50px', `an emoji-only note should be 50 px (${fire?.font})`);
  expect(fire && !(await page.$(`[data-resize="${fire.id}"]`)), 'an emoji-only note should have no resize corner');
  // Emptied, a note goes.
  await page.mouse.dblclick(fire.r.x + 20, fire.r.y + 30);
  await page.waitForSelector('.note textarea');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await sleep(300);
  expect((await notes()).length === 1, 'an emptied note should be removed');

  // Reference: a chord by root and variant; chords tapped on the circle, recorded as a sketch.
  const count = (await tiles()).length;
  await page.click('button[aria-label^="Reference"]');
  await page.waitForSelector('.reference');
  await page.click('.tabs button:has-text("Chords")');
  await page.click('.root:has-text("B♭")');
  const cards = await page.$$eval('.cards .card', (els) => els.map((e) => e.getAttribute('aria-label')));
  expect(cards.length === 19 && cards[0] === 'B♭' && cards.includes('B♭m7♭5'), `every chord of the root on one page (${cards.join(', ')})`);
  const seventh = await page.textContent('.card[aria-label="B♭7"] .tones');
  expect(seventh.includes('A♭'), `a chord's notes (${seventh})`);
  await page.click('.segmented[aria-label="Instrument"] button:has-text("Guitar")');
  const shapes = await page.$$eval('.card[aria-label="B♭"] .shape', (els) => els.length);
  expect(shapes > 1, `every guitar shape shown (${shapes})`);
  await page.click('.tabs button:has-text("Circle of fifths")');
  await page.click('button.record');
  for (const chord of ['C', 'Am', 'F', 'G']) {
    await page.click(`.cell[aria-label^="${chord}."]`);
    await sleep(250);
  }
  await page.click('button.record');
  await sleep(1500);
  await page.click('button[aria-label="Back to the notebook"]');
  await page.waitForSelector('[data-tile]');
  await sleep(500);
  const after = await tiles();
  expect(after.length === count + 1 && after.some((t) => t.label === 'C – Am – F – G'), `chords tapped on the circle should be a new sketch (${after.map((t) => t.label).join(', ')})`);

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
