/**
 * Rendering a library sample with its settings, and playing it: on a tap in
 * the library, on a rhythm's pad, or pitched to each note of a sketch.
 *
 * The stored audio (a mono WAV) is read once; each (settings, sample rate)
 * rendering is cached. Rendering is `shapeSample` (trim, reverse, normalize,
 * envelope, level) in JS, then, when needed, an OfflineAudioContext for
 * transposition (resampled), the filters and the reverb (a convolution with
 * a decaying noise burst).
 */
import { decodeWav } from '../audio/wav';
import type { Sample } from '../library/types';
import { fileUrl } from '../platform/tauri';
import { normalizeSampleSettings, playedRoot, rateFor, shapeSample, toMono, type SampleSettings } from './settings';

export interface MonoAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** A sound and the note it sounds at: notes are played by resampling it. */
export interface PitchedSample {
  buffer: AudioBuffer;
  /** Fractional MIDI note. */
  root: number;
}

type OfflineCtor = typeof OfflineAudioContext;

function offlineClass(): OfflineCtor | null {
  if (typeof window === 'undefined') return null;
  return window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext ?? null;
}

function renderOffline(ctx: OfflineAudioContext): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    ctx.oncomplete = (event) => resolve(event.renderedBuffer);
    // Older WebKit returns undefined and only fires `oncomplete`.
    const result = ctx.startRendering() as Promise<AudioBuffer> | undefined;
    result?.then(resolve, reject);
  });
}

// ---------------------------------------------------------------- reading

const audioCache = new Map<string, Promise<MonoAudio>>();

/** A sample's stored audio, mono (read once). */
export function loadSampleAudio(sample: Pick<Sample, 'id' | 'audioPath'>): Promise<MonoAudio> {
  const path = sample.audioPath;
  if (!path) return Promise.reject(new Error('the sample has no audio yet'));
  const key = `${sample.id}|${path}`;
  let pending = audioCache.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(fileUrl(path));
      if (!response.ok) throw new Error(`could not read the sample (${response.status})`);
      const pcm = decodeWav(await response.arrayBuffer());
      return { samples: toMono(pcm.channels), sampleRate: pcm.sampleRate };
    })();
    pending.catch(() => audioCache.delete(key));
    audioCache.set(key, pending);
  }
  return pending;
}

// -------------------------------------------------------------- rendering

/** A reverb's impulse: noise falling away over `seconds` (fixed seed: every rendering is the same). */
export function impulse(sampleRate: number, seconds: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  let seed = 98765;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    const t = i / n;
    out[i] = ((seed / 2147483647) * 2 - 1) * (1 - t) ** 2.2 * Math.exp(-3 * t);
  }
  return out;
}

/** Whether rendering needs Web Audio (transposition, a different rate, filters or reverb). */
export function needsWebAudio(settings: SampleSettings, from: number, to: number): boolean {
  return settings.pitch !== 0 || from !== to || settings.lowpassHz !== null || settings.highpassHz !== null || settings.reverb > 0;
}

/** Render `audio` with `settings` at `sampleRate`, as plain samples. */
export async function renderSampleData(audio: MonoAudio, settings: SampleSettings, sampleRate: number): Promise<Float32Array<ArrayBuffer>> {
  const shaped = shapeSample(audio.samples, audio.sampleRate, settings);
  if (!needsWebAudio(settings, audio.sampleRate, sampleRate)) return shaped;
  const Offline = offlineClass();
  if (!Offline) throw new Error('Offline audio rendering is not available here');
  const rate = rateFor(0, settings.pitch);
  const dry = shaped.length / audio.sampleRate / rate;
  const tail = settings.reverb > 0 ? settings.reverbSize : 0;
  const ctx = new Offline(1, Math.max(1, Math.ceil((dry + tail + 0.02) * sampleRate)), sampleRate);
  const buffer = ctx.createBuffer(1, shaped.length, audio.sampleRate);
  buffer.copyToChannel(shaped, 0);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  let node: AudioNode = source;
  if (settings.highpassHz !== null) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = settings.highpassHz;
    node = node.connect(hp);
  }
  if (settings.lowpassHz !== null) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = settings.lowpassHz;
    node = node.connect(lp);
  }
  if (settings.reverb > 0) {
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1 - 0.5 * settings.reverb;
    node.connect(dryGain).connect(ctx.destination);
    const convolver = ctx.createConvolver();
    const ir = ctx.createBuffer(1, Math.max(1, Math.round(settings.reverbSize * sampleRate)), sampleRate);
    ir.copyToChannel(impulse(sampleRate, settings.reverbSize), 0);
    convolver.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = settings.reverb * 0.9;
    node.connect(convolver).connect(wet).connect(ctx.destination);
  } else {
    node.connect(ctx.destination);
  }
  source.start(0);
  const rendered = await renderOffline(ctx);
  return rendered.getChannelData(0).slice();
}

const rendered = new Map<string, Promise<Float32Array<ArrayBuffer>>>();
const renderedSizes = new Map<string, number>();
/**
 * Renderings kept, in samples (4 bytes each): about 40 MB. A sample can be a
 * minute long, and an iOS web view is ended when it uses too much memory;
 * rendering again is quick.
 */
const RENDER_BUDGET = 10_000_000;

function evictRenderings(keep: string) {
  let total = 0;
  for (const size of renderedSizes.values()) total += size;
  for (const key of rendered.keys()) {
    if (total <= RENDER_BUDGET) break;
    if (key === keep || !renderedSizes.has(key)) continue;
    total -= renderedSizes.get(key)!;
    renderedSizes.delete(key);
    rendered.delete(key);
  }
}

function renderKey(sample: Pick<Sample, 'id' | 'updatedAt'>, sampleRate: number) {
  return `${sample.id}|${sample.updatedAt}|${sampleRate}`;
}

/** A sample as it sounds (its settings applied), at `sampleRate` (cached). */
export function renderedSample(sample: Sample, sampleRate: number): Promise<Float32Array<ArrayBuffer>> {
  const key = renderKey(sample, sampleRate);
  let pending = rendered.get(key);
  if (pending) {
    rendered.delete(key);
    rendered.set(key, pending);
    return pending;
  }
  pending = loadSampleAudio(sample).then((audio) => renderSampleData(audio, normalizeSampleSettings(sample.settings), sampleRate));
  rendered.set(key, pending);
  pending.then(
    (data) => {
      renderedSizes.set(key, data.length);
      // Older renderings of the same sample (before its settings changed) are never asked for again.
      for (const other of [...rendered.keys()]) {
        if (other !== key && other.startsWith(`${sample.id}|`) && other.endsWith(`|${sampleRate}`)) {
          rendered.delete(other);
          renderedSizes.delete(other);
        }
      }
      evictRenderings(key);
    },
    () => {
      rendered.delete(key);
      renderedSizes.delete(key);
    },
  );
  return pending;
}

/** The rendered sample as a buffer of `ctx`. */
export async function sampleBuffer(ctx: BaseAudioContext, sample: Sample): Promise<AudioBuffer> {
  const data = await renderedSample(sample, ctx.sampleRate);
  const buffer = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
  buffer.copyToChannel(data, 0);
  return buffer;
}

/** The rendered sample with the note it sounds at, for playing notes with it. */
export async function pitchedSample(ctx: BaseAudioContext, sample: Sample): Promise<PitchedSample> {
  return { buffer: await sampleBuffer(ctx, sample), root: playedRoot(normalizeSampleSettings(sample.settings)) };
}

/** Forget the renderings of a sample (it was deleted). */
export function forgetSample(id: string) {
  for (const key of [...rendered.keys()]) {
    if (!key.startsWith(`${id}|`)) continue;
    rendered.delete(key);
    renderedSizes.delete(key);
  }
  for (const key of [...audioCache.keys()]) if (key.startsWith(`${id}|`)) audioCache.delete(key);
}

// ---------------------------------------------------------------- playing

export interface SampleVoice {
  sources: AudioScheduledSourceNode[];
  gain: GainNode;
  start: number;
  end: number;
}

/** Gain for a MIDI velocity. */
export function velocityGain(velocity: number): number {
  return 0.85 * (Math.min(127, Math.max(1, velocity)) / 127) ** 1.2;
}

/**
 * One note played with a sample: resampled from its root to `pitch`
 * (`rateFor`), from `when` for `length` seconds, then released. It ends
 * sooner if the sample does (a one-shot rings out on its own).
 */
export function scheduleSampleNote(
  ctx: BaseAudioContext,
  destination: AudioNode,
  sample: PitchedSample,
  pitch: number,
  velocity: number,
  when: number,
  length: number,
  release = 0.12,
): SampleVoice {
  const rate = rateFor(sample.root, pitch);
  const source = ctx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = rate;
  const gain = ctx.createGain();
  const peak = velocityGain(velocity);
  const natural = sample.buffer.duration / rate;
  const hold = Math.max(0.02, Math.min(length, natural));
  const end = Math.min(when + natural, when + hold + release);
  gain.gain.setValueAtTime(peak, when);
  if (hold < natural) {
    gain.gain.setValueAtTime(peak, when + hold);
    gain.gain.linearRampToValueAtTime(0, when + hold + release);
  }
  source.connect(gain).connect(destination);
  source.start(when);
  source.stop(end + 0.02);
  return { sources: [source], gain, start: when, end };
}

/** Play a sample once on a tap (or a pad): returns a stop function. */
export function playOnce(ctx: BaseAudioContext, destination: AudioNode, buffer: AudioBuffer, when = 0, level = 1): () => void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = level;
  source.connect(gain).connect(destination);
  const at = Math.max(when, ctx.currentTime);
  source.start(at);
  return () => {
    const now = ctx.currentTime;
    gain.gain.setTargetAtTime(0, now, 0.01);
    try {
      source.stop(now + 0.05);
    } catch {
      // already stopped
    }
  };
}
