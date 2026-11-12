#!/usr/bin/env node
/**
 * Stand-in for the Apple Watch app on the local network: pairs with Earbud and
 * sends an audio file, using the same TCP protocol (see watch-app/README.md).
 * Useful for checking Earbud's receiver on a Mac, PC or iPhone without a Watch.
 *
 *   node scripts/fake-watch.mjs pair <host> <code>       # code from Settings → Apple Watch
 *   node scripts/fake-watch.mjs send <host> <audio file> # .m4a, .wav, …
 *
 * `pair` saves the receiver's name, id and secret to ./fake-watch-link.json
 * (or FAKE_WATCH_LINK); `send` reads them from there. Port: EARBUD_PORT or 50720.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, extname } from 'node:path';

const PORT = Number(process.env.EARBUD_PORT ?? 50720);
const LINK_FILE = process.env.FAKE_WATCH_LINK ?? 'fake-watch-link.json';
const NAME = process.env.FAKE_WATCH_NAME ?? 'Fake Watch';

const MIME = { m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', caf: 'audio/x-caf', aac: 'audio/aac' };

function lengthPrefixed(payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  return Buffer.concat([head, payload]);
}

/** Send `frame`, collect the reply until the server closes the connection. */
function exchange(host, port, frame, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer from ${host}:${port}`));
    }, timeoutMs);
    socket.on('connect', () => socket.write(frame));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      clearTimeout(timer);
      // The server may refuse and close before it has read everything.
      if (chunks.length > 0) resolve(Buffer.concat(chunks));
      else reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function pair(host, code, { port = PORT, deviceName = NAME } = {}) {
  const request = Buffer.from(JSON.stringify({ code, deviceName }));
  const reply = await exchange(host, port, Buffer.concat([Buffer.from([0x02]), lengthPrefixed(request)]));
  if (reply[0] !== 1) throw new Error('refused: wrong or expired code');
  const length = reply.readUInt32BE(1);
  const response = JSON.parse(reply.subarray(5, 5 + length).toString('utf8'));
  return { host, port: response.port || port, displayName: response.displayName, deviceId: response.deviceId, secret: response.token };
}

export async function send(link, file, { createdAt = new Date(), durationSeconds = 0, name } = {}) {
  const audio = readFileSync(file);
  const ext = extname(file).slice(1).toLowerCase() || 'm4a';
  const header = {
    byteCount: audio.length,
    pairingSecret: link.secret,
    recording: {
      createdAt: createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      duration: durationSeconds,
      fileExtension: ext,
      id: randomUUID().toUpperCase(),
      mimeType: MIME[ext] ?? 'application/octet-stream',
      name: name ?? basename(file),
    },
    senderName: NAME,
  };
  const frame = Buffer.concat([
    Buffer.from([0x01]),
    lengthPrefixed(Buffer.from(JSON.stringify(header))),
    audio,
  ]);
  const reply = await exchange(link.host, link.port, frame);
  if (reply[0] !== 1) throw new Error('refused: not paired with this device (pair again)');
  return header.recording;
}

/** Duration of a PCM WAV in seconds (0 if not a WAV). */
function wavSeconds(file) {
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const byteRate = bytes.readUInt32LE(28);
  return byteRate > 0 ? (bytes.length - 44) / byteRate : 0;
}

async function main() {
  const [command, host, arg] = process.argv.slice(2);
  if (command === 'pair' && host && arg) {
    const link = await pair(host, arg);
    writeFileSync(LINK_FILE, JSON.stringify(link, null, 2));
    console.log(`Paired with “${link.displayName}” (${link.host}:${link.port}). Saved to ${LINK_FILE}.`);
  } else if (command === 'send' && host && arg) {
    const link = { ...JSON.parse(readFileSync(LINK_FILE, 'utf8')), host };
    statSync(arg);
    const recording = await send(link, arg, { durationSeconds: wavSeconds(arg) });
    console.log(`Sent “${recording.name}” to “${link.displayName}”.`);
  } else {
    console.error('usage: fake-watch.mjs pair <host> <code> | send <host> <audio file>');
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
