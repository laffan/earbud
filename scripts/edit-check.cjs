/**
 * Note-editing regression check (browser preview with the ?demo sketch, phone
 * width): drag a rectangle to select several notes, transpose / move / delete
 * them together, undo, join notes of the same pitch, scroll by the time ruler.
 * Fails on any page error or error toast.
 *
 *   npm run dev            # terminal 1
 *   npm run smoke:edit
 */
const { chromium } = require('playwright');
const URL = process.env.SMOKE_URL ?? 'http://localhost:1420/';
const OUT = process.env.SMOKE_OUT;

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await page.goto(`${URL}?demo`);
  await page.waitForSelector('.card', { timeout: 30000 });
  await page.click('.front');
  await page.waitForSelector('.roll canvas');
  await page.waitForTimeout(800);

  const noteCount = async () =>
    Number(
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('.details div')].find((d) => d.querySelector('dt')?.textContent === 'Notes');
        return row?.querySelector('dd')?.textContent?.trim().split(' ')[0];
      }),
    );
  const selected = async () => {
    const el = await page.$('.selection-count');
    return el ? parseInt(await el.textContent(), 10) : 0;
  };
  const expect = (ok, message) => {
    if (!ok) problems.push(message);
  };

  await page.click('button:has-text("Edit notes")');
  await page.waitForSelector('.edit-toolbar');
  const roll = await (await page.$('.roll canvas')).boundingBox();
  const total = await noteCount();
  console.log('notes in the demo sketch:', total);

  // The roll area starts right of the 40 px keyboard and below the 42 px chord lane + ruler.
  const left = roll.x + 46;
  const top = roll.y + 46;
  const drag = async (x0, y0, x1, y1, steps = 12) => {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  };

  // 1. Drag a rectangle over the left half of the roll.
  await drag(left, top, roll.x + roll.width * 0.6, roll.y + roll.height - 12);
  if (OUT) await page.screenshot({ path: `${OUT}-marquee.png` });
  await page.mouse.up();
  const many = await selected();
  console.log('selected by dragging:', many);
  expect(many >= 2, `dragging a rectangle selected ${many} notes`);
  expect(many < total, 'the rectangle selected every note, expected a subset');

  // 2. Transpose the selection: the count and the selection survive.
  await page.click('[aria-label="Semitone up"]');
  expect((await selected()) === many, 'selection lost after transposing');
  expect((await noteCount()) === total, 'note count changed after transposing');

  // 3. Drag one of the selected notes: the whole selection stays selected.
  await page.click('[aria-label="Later"]');
  expect((await selected()) === many, 'selection lost after nudging');

  // 4. Delete the selection, then undo.
  await page.click('[aria-label="Delete selected notes"]');
  await page.waitForTimeout(100);
  expect((await noteCount()) === total - many, `delete removed ${total - (await noteCount())} notes, expected ${many}`);
  expect((await selected()) === 0, 'selection not cleared after delete');
  await page.click('[aria-label="Undo"]');
  expect((await noteCount()) === total, 'undo did not restore the deleted notes');

  // 5. A tap on empty space clears the selection; Shift-drag adds to it.
  await drag(left, top, roll.x + roll.width * 0.35, roll.y + roll.height - 12);
  await page.mouse.up();
  const first = await selected();
  await page.keyboard.down('Shift');
  await drag(roll.x + roll.width * 0.45, top, roll.x + roll.width * 0.7, roll.y + roll.height - 12);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const both = await selected();
  console.log('first rectangle:', first, 'after Shift-drag:', both);
  expect(both > first, 'Shift-drag did not add to the selection');
  await page.mouse.click(left, top);
  expect((await selected()) === 0, 'tap on empty space did not clear the selection');

  // 6. Select all and join notes of the same pitch.
  await drag(left, top, roll.x + roll.width * 0.5, roll.y + roll.height - 12);
  await page.mouse.up();
  await page.click('button:has-text("Select all")');
  expect((await selected()) === total, 'Select all did not select every note');
  await page.click('button:has-text("Join")');
  await page.waitForTimeout(100);
  const joined = await noteCount();
  console.log('notes after joining every pitch:', joined);
  expect(joined < total, 'Join did not merge notes of the same pitch');
  await page.click('[aria-label="Undo"]');
  expect((await noteCount()) === total, 'undo did not restore the joined notes');

  // 7. Dragging the time ruler still scrolls (zoom in first so there is somewhere to go).
  await page.click('[aria-label="Zoom in"]');
  await page.click('[aria-label="Zoom in"]');
  await page.mouse.click(left, top);
  const before = await page.screenshot({ clip: { x: roll.x, y: roll.y, width: roll.width, height: 40 } });
  await drag(roll.x + roll.width * 0.8, roll.y + 34, roll.x + roll.width * 0.3, roll.y + 34);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const after = await page.screenshot({ clip: { x: roll.x, y: roll.y, width: roll.width, height: 40 } });
  expect(!before.equals(after), 'dragging the time ruler did not scroll the roll');
  expect((await selected()) === 0, 'dragging the time ruler selected notes');

  if (OUT) await page.screenshot({ path: `${OUT}-end.png` });
  const toast = await page.$('.toast.error');
  if (toast) problems.push(`error toast: ${await toast.textContent()}`);
  await browser.close();
  if (problems.length) {
    console.error('FAILED:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('note editing OK');
})();
