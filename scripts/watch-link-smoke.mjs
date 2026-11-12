/**
 * End-to-end check of the Apple Watch receiver in the real desktop app:
 * opens Settings → Apple Watch, pairs a fake Watch with the code shown on
 * screen, sends a recording over TCP, and waits for it to appear in the list
 * (tagged "Apple Watch") and be transcribed. Linux only (tauri-driver).
 *
 *   npm run build
 *   (cd src-tauri && cargo build --features tauri/custom-protocol)
 *   node scripts/make-test-audio.mjs /tmp/chords.wav
 *   xvfb-run -a tauri-driver --port 4444 &
 *   SMOKE_WAV=/tmp/chords.wav node scripts/watch-link-smoke.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pair, send } from './fake-watch.mjs';

const DRIVER = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
const BIN = resolve(process.env.EARBUD_BIN ?? 'src-tauri/target/debug/earbud');
const WAV = process.env.SMOKE_WAV ?? '/tmp/chords.wav';
const OUT = process.env.SMOKE_OUT ?? 'test-results/watch';
mkdirSync(OUT, { recursive: true });

async function wd(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json)}`);
  return json.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = await wd('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: BIN } } },
});
const sid = session.sessionId;
const run = (body, ...args) =>
  wd('POST', `/session/${sid}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      (async (...args) => { ${body} })(...Array.from(arguments).slice(0, -1))
        .then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: String(e && e.message || e) }));`,
    args,
  }).then((r) => {
    if (!r.ok) throw new Error(r.e);
    return r.v;
  });
const screenshot = async (name) => {
  const png = await wd('GET', `/session/${sid}/screenshot`);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(png, 'base64'));
};
async function until(label, body, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await run(body);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(300);
  }
}
const text = (selector) => `return [...document.querySelectorAll('${selector}')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim());`;

let failed = false;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

try {
  await until('the app', `return document.querySelector('h1')?.textContent === 'Earbud';`, 30_000);
  // Start from a clean receiver: forget earlier pairings, receiving off.
  await run(`
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke('watch_link_reset');
    await invoke('watch_link_set_name', { name: 'Smoke Desk' });
    await invoke('watch_link_set_enabled', { enabled: false });
    location.reload();
  `).catch(() => {});
  await sleep(1500);
  await until('the app after reload', `return document.querySelector('h1')?.textContent === 'Earbud';`, 30_000);

  await run(`document.querySelector('button[aria-label="Settings"]').click();`);
  await until('the Apple Watch section', `return [...document.querySelectorAll('h3')].some((h) => h.textContent === 'Apple Watch');`);
  await run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Pair Apple Watch').click();`);
  const code = await until('a pairing code', `return [...document.querySelectorAll('.code span')].map((s) => s.textContent).join('') || null;`);
  check(/^\d{5}$/.test(code), `pairing code shown: ${code}`);
  await run(`document.querySelector('.code')?.scrollIntoView({ block: 'center' });`);
  await screenshot('1-pairing-code');

  let wrong = 'refused';
  try {
    await pair('127.0.0.1', code === '00000' ? '11111' : '00000');
    wrong = 'accepted';
  } catch {
    // expected
  }
  check(wrong === 'refused', 'a wrong code is refused');

  const link = await pair('127.0.0.1', code);
  check(link.displayName === 'Smoke Desk', `the Watch learns the receiver's name: “${link.displayName}”`);
  const toast = await until('the paired toast', `return [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).find((t) => t.startsWith('Paired with')) ?? null;`);
  check(toast === 'Paired with Fake Watch.', `toast: ${toast}`);
  const paired = await until('the paired list', `return document.querySelector('.paired li')?.textContent.replace(/\\s+/g, ' ').trim() ?? null;`);
  check(paired.startsWith('Fake Watch'), `paired list: ${paired}`);
  check(!(await run(`return !!document.querySelector('.code');`)), 'the code is gone after pairing');
  await screenshot('2-paired');

  const facts = await run(text('.facts li'));
  console.log('     receiver:', facts.join(' | '));

  const createdAt = new Date(Date.now() - 3 * 60_000);
  const recording = await send(link, WAV, { createdAt, durationSeconds: 7, name: 'Smoke take' });
  const sketchId = recording.id.replace(/-/g, '').toLowerCase();
  check(true, `sent recording ${recording.id}`);

  // Close Settings and find the new sketch in the list.
  await run(`document.querySelector('.backdrop')?.click();`);
  const chips = await until(
    'the Watch recording in the list',
    `const card = [...document.querySelectorAll('.card')].find((c) => [...c.querySelectorAll('.chip')].some((chip) => chip.textContent.trim() === 'Apple Watch'));
     return card ? [...card.querySelectorAll('.chip')].map((c) => c.textContent.trim()) : null;`,
  );
  check(chips.includes('Apple Watch'), `card chips: ${chips.join(', ')}`);
  const stored = await run(`return await window.__TAURI_INTERNALS__.invoke('get_sketch', { id: args[0] });`, sketchId);
  check(stored.captureBackend === 'apple-watch', `stored with capture backend ${stored.captureBackend}`);
  check(Math.abs(stored.createdAt - createdAt.getTime()) < 1000, 'dated when it was recorded, not when it arrived');
  check(stored.durationMs === 7000 && !stored.hasVideo, `duration ${stored.durationMs} ms, audio only`);

  const status = await until(
    'transcription',
    `const s = await window.__TAURI_INTERNALS__.invoke('get_sketch', { id: args[0] });
     return s.transcriptionStatus === 'done' || s.transcriptionStatus === 'failed' ? s : null;`.replace('args[0]', JSON.stringify(sketchId)),
    120_000,
  );
  check(status.transcriptionStatus === 'done', `transcription ${status.transcriptionStatus}${status.summary ? `: ${status.summary.chords.join(' – ')}` : ''}`);
  await sleep(500);
  await screenshot('3-list');

  // A second recording (a new id) is added alongside. Duplicates of one id are covered by the Rust tests.
  const count = async () => (await run(`return (await window.__TAURI_INTERNALS__.invoke('list_sketches')).filter((s) => s.captureBackend === 'apple-watch').length;`));
  const before = await count();
  await send(link, WAV, { createdAt, durationSeconds: 7, name: "Smoke take 2" });
  await sleep(800);
  check((await count()) === before + 1, 'a second recording is added');

  // After "Forget paired watches" the old secret is refused.
  await run(`await window.__TAURI_INTERNALS__.invoke('watch_link_reset');`);
  let refused = false;
  try {
    await send(link, WAV, { durationSeconds: 7 });
  } catch {
    refused = true;
  }
  check(refused, 'after a reset the old pairing is refused');
} finally {
  await wd('DELETE', `/session/${sid}`).catch(() => {});
}
process.exit(failed ? 1 : 0);
