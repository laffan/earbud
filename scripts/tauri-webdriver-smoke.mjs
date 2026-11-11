/**
 * Drives the real desktop app (Rust library + SQLite + asset protocol + IPC)
 * through WebDriver: creates a sketch from a synthesized WAV over the raw
 * byte IPC channel, lets the app's processing queue transcribe it, then opens
 * it in the UI and checks that the recording plays through the asset
 * protocol. Linux only (tauri-driver + WebKitWebDriver).
 *
 *   npm run build
 *   (cd src-tauri && cargo build --features tauri/custom-protocol)
 *   xvfb-run -a tauri-driver --port 4444 &
 *   EARBUD_BIN=src-tauri/target/debug/earbud node scripts/tauri-webdriver-smoke.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DRIVER = process.env.WEBDRIVER_URL ?? 'http://127.0.0.1:4444';
const BIN = resolve(process.env.EARBUD_BIN ?? 'src-tauri/target/debug/earbud');
const OUT = process.env.SMOKE_OUT ?? 'test-results/tauri';
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

const session = await wd('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: BIN } } },
});
const sid = session.sessionId;
const run = (fn, ...args) =>
  wd('POST', `/session/${sid}/execute/async`, {
    script: `const done = arguments[arguments.length - 1];
      (${fn.toString()})(...Array.from(arguments).slice(0, -1))
        .then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: String(e && e.message || e) }));`,
    args,
  }).then((r) => {
    if (!r.ok) throw new Error(r.e);
    return r.v;
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const screenshot = async (name) =>
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(await wd('GET', `/session/${sid}/screenshot`), 'base64'));

try {
  // The first launch after a build can be slow under a virtual display.
  let title = null;
  for (let i = 0; i < 40 && title !== 'Earbud'; i++) {
    await sleep(500);
    title = await run(async () => document.querySelector('h1')?.textContent ?? null);
  }
  if (title !== 'Earbud') throw new Error(`app did not render (h1=${title})`);
  const caps = await run(async () => window.__TAURI_INTERNALS__.invoke('plugin:capture|capabilities'));
  console.log('capabilities', caps);

  // 1. Create a sketch through the same commands the capture flow uses.
  const created = await run(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const rate = 44100;
    const samples = new Float32Array(rate * 6);
    const chords = [[36, 60, 64, 67], [45, 57, 60, 64], [41, 57, 60, 65], [43, 55, 59, 62, 65]];
    chords.forEach((pitches, i) => {
      const start = 0.3 + i * 1.4;
      for (const p of pitches) {
        const f = 440 * 2 ** ((p - 69) / 12);
        for (let n = Math.floor(start * rate); n < (start + 1.25) * rate; n++) {
          const t = n / rate - start;
          const env = Math.min(1, t * 300) * Math.exp(-t * 2.2) * Math.min(1, (1.25 - t) / 0.03);
          let s = 0;
          for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t) / (h * h);
          samples[n] += 0.1 * env * s;
        }
      }
    });
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));

    const sketch = await invoke('create_sketch', {
      args: { mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'webdriver-test' },
    });
    const half = Math.floor(bytes.length / 2);
    for (const chunk of [bytes.slice(0, half), bytes.slice(half)]) {
      await invoke('write_sketch_file', chunk, { headers: { 'x-sketch-id': sketch.id, 'x-file-kind': 'media-chunk' } });
    }
    await invoke('finalize_sketch', {
      args: { id: sketch.id, durationMs: 6000, hasVideo: false, videoWidth: null, videoHeight: null },
    });
    return sketch;
  });
  console.log('created', created.id, created.mediaPath);

  // 2. Reload: the app's queue picks up the pending sketch.
  await run(async () => location.reload());
  await sleep(2000);
  let sketch;
  const started = Date.now();
  for (;;) {
    sketch = await run(async (id) => window.__TAURI_INTERNALS__.invoke('get_sketch', { id }), created.id);
    if (sketch.transcriptionStatus === 'done' || sketch.transcriptionStatus === 'failed') break;
    if (Date.now() - started > 300_000) throw new Error('transcription timed out');
    await sleep(2000);
  }
  console.log(`transcription ${sketch.transcriptionStatus} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (sketch.transcriptionStatus !== 'done') throw new Error(`transcription failed: ${sketch.transcriptionError}`);
  console.log('chords', sketch.summary.chords.join(' '), '| notes', sketch.transcription.originalNotes.length);
  console.log('analysis', sketch.analysisPath);
  if (sketch.summary.chords.join(' ') !== 'C Am F G7') throw new Error('unexpected chords');

  // 3. Open it and confirm playback through the asset protocol.
  await run(async () => document.querySelector('.card').click());
  await sleep(2500);
  const media = await run(async () => {
    const v = document.querySelector('video');
    return { readyState: v.readyState, duration: v.duration, src: v.currentSrc, error: v.error?.code ?? null };
  });
  console.log('media', media);
  if (!(media.readyState >= 1 && Math.abs(media.duration - 6) < 0.2)) throw new Error('recording did not load');
  await screenshot('sketch');

  // 4. Export bundle (friendly-named hard links of the originals).
  const bundle = await run(
    async (id) => window.__TAURI_INTERNALS__.invoke('prepare_export', { id, baseName: 'Smoke: test/1' }),
    created.id,
  );
  console.log('export', bundle);
  await run(async (id) => window.__TAURI_INTERNALS__.invoke('delete_sketch', { id }), created.id);
  console.log('TAURI SMOKE OK');
} finally {
  await wd('DELETE', `/session/${sid}`).catch(() => {});
}
