/**
 * A take's recording decoded into an AudioBuffer for playback, and
 * stretched copies for slowed playback.
 *
 * Where the sound comes from, in order:
 *  1. Takes with video on iOS: the audio track written next to the
 *     recording by AVFoundation (`take-audio.m4a`, also used for export), so
 *     the video file is never read into memory.
 *  2. The recording itself, decoded by the web view (audio files, and video
 *     on desktop where memory is not tight).
 *  3. The 22.05 kHz analysis WAV made for transcription (always there once
 *     the take is processed; duller, but it plays).
 *
 * Decoded buffers are cached by file, within a memory budget, so reopening
 * a sketch does not decode it again.
 */
import { decodeWav } from '../audio/wav';
import { takeAudioPathFor } from '../library/types';
import { fileUrl } from '../platform/tauri';

export interface TakeAudioSource {
  mediaPath: string | null;
  analysisPath: string | null;
  hasVideo: boolean;
}

export interface DecodeDeps {
  /** Writes the take's audio track to `outputPath` natively (iOS). */
  exportAudio?: (mediaPath: string, outputPath: string) => Promise<void>;
  log?: (message: string) => void;
}

/** Recordings larger than this are not read into memory to decode (bytes). */
const DIRECT_DECODE_LIMIT = 400 * 1024 * 1024;
/**
 * Decoded audio kept for reopening sketches (samples, all channels; 4 bytes each): about ten minutes of mono
 * audio, ~115 MB. Small on purpose: an iOS web view is ended when it uses too much memory, and decoding again is quick.
 */
const CACHE_BUDGET = 48_000 * 60 * 10;

const cache = new Map<string, Promise<AudioBuffer>>();
const sizes = new Map<string, number>();

/** Decode a take's sound for `ctx` (cached). Rejects only when no source at all can be decoded. */
export function loadTakeBuffer(ctx: BaseAudioContext, take: TakeAudioSource, deps: DecodeDeps = {}): Promise<AudioBuffer> {
  const key = `${take.mediaPath ?? take.analysisPath}@${ctx.sampleRate}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit;
  }
  const pending = decodeTake(ctx, take, deps);
  cache.set(key, pending);
  pending.then(
    (buffer) => {
      sizes.set(key, buffer.length * buffer.numberOfChannels);
      evict(key);
      if (deps.log) {
        let peak = 0;
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          for (const value of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(value));
        }
        deps.log(`decoded sound: ${buffer.duration.toFixed(2)} s, ${buffer.sampleRate} Hz, ` +
          `${buffer.numberOfChannels} channels, peak=${peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : 'silent'}`);
      }
    },
    () => {
      cache.delete(key);
      sizes.delete(key);
    },
  );
  return pending;
}

function evict(keep: string) {
  let total = 0;
  for (const size of sizes.values()) total += size;
  for (const key of cache.keys()) {
    if (total <= CACHE_BUDGET) break;
    if (key === keep || !sizes.has(key)) continue;
    total -= sizes.get(key)!;
    sizes.delete(key);
    cache.delete(key);
  }
}

async function decodeTake(ctx: BaseAudioContext, take: TakeAudioSource, deps: DecodeDeps): Promise<AudioBuffer> {
  const log = deps.log ?? (() => {});
  const errors: string[] = [];
  if (take.mediaPath && take.hasVideo && deps.exportAudio) {
    try {
      return await decodeFile(ctx, await nativeAudioTrack(take.mediaPath, deps.exportAudio));
    } catch (error) {
      errors.push(`audio track: ${message(error)}`);
    }
  }
  if (take.mediaPath) {
    try {
      return await decodeFile(ctx, take.mediaPath);
    } catch (error) {
      errors.push(`recording: ${message(error)}`);
    }
  }
  if (take.analysisPath) {
    try {
      const buffer = await decodeWavFile(ctx, take.analysisPath);
      log(`playing the analysis audio (${errors.join('; ')})`);
      return buffer;
    } catch (error) {
      errors.push(`analysis audio: ${message(error)}`);
    }
  }
  throw new Error(errors.join('; ') || 'nothing to play');
}

/** The take's audio track as a file: written once by the native exporter, then reused. */
async function nativeAudioTrack(mediaPath: string, exportAudio: NonNullable<DecodeDeps['exportAudio']>): Promise<string> {
  const path = takeAudioPathFor(mediaPath);
  const existing = await fetch(fileUrl(path)).catch(() => null);
  void existing?.body?.cancel().catch(() => {});
  if (!existing?.ok) await exportAudio(mediaPath, path);
  return path;
}

async function readFile(path: string): Promise<ArrayBuffer> {
  const response = await fetch(fileUrl(path));
  if (!response.ok) throw new Error(`could not read it (${response.status})`);
  const size = Number(response.headers.get('content-length'));
  if (size > DIRECT_DECODE_LIMIT) {
    void response.body?.cancel().catch(() => {});
    throw new Error('too large to decode in memory');
  }
  return response.arrayBuffer();
}

async function decodeFile(ctx: BaseAudioContext, path: string): Promise<AudioBuffer> {
  return decodeAudio(ctx, await readFile(path));
}

/** decodeAudioData, also where it only takes callbacks (older WebKit). */
export function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const fail = (error?: unknown) => reject(error instanceof Error ? error : new Error('the format cannot be decoded here'));
    try {
      const result = ctx.decodeAudioData(data, resolve, fail) as Promise<AudioBuffer> | undefined;
      result?.then?.(resolve, fail);
    } catch (error) {
      fail(error);
    }
  });
}

async function decodeWavFile(ctx: BaseAudioContext, path: string): Promise<AudioBuffer> {
  const pcm = decodeWav(await readFile(path));
  const length = pcm.channels[0]?.length ?? 0;
  if (length === 0) throw new Error('empty');
  const buffer = ctx.createBuffer(pcm.channels.length, length, pcm.sampleRate);
  pcm.channels.forEach((samples, c) => buffer.getChannelData(c).set(samples));
  return buffer;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------ stretching

let worker: Worker | null = null;
let nextRequest = 0;
const requests = new Map<number, { resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void }>();

function stretchWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; error?: string }>) => {
      const request = requests.get(event.data.id);
      requests.delete(event.data.id);
      if (!request) return;
      if (event.data.channels) request.resolve(event.data.channels);
      else request.reject(new Error(event.data.error ?? 'stretching failed'));
    };
    worker.onerror = (event) => {
      for (const request of requests.values()) request.reject(new Error(event.message || 'stretching failed'));
      requests.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/** A copy of `buffer` that plays at `rate` of its speed at the same pitch (made in a worker). */
export async function stretchBuffer(ctx: BaseAudioContext, buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
  const id = nextRequest++;
  const stretched = await new Promise<Float32Array[]>((resolve, reject) => {
    requests.set(id, { resolve, reject });
    stretchWorker().postMessage(
      { id, channels, sampleRate: buffer.sampleRate, rate },
      channels.map((c) => c.buffer),
    );
  });
  const out = ctx.createBuffer(stretched.length, stretched[0].length, buffer.sampleRate);
  stretched.forEach((samples, c) => out.getChannelData(c).set(samples));
  return out;
}
