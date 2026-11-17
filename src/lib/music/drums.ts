/**
 * The rhythm pads' sounds: kick, snare, hi-hat and clap, synthesized once
 * per sample rate into short one-shot samples, or a library sample chosen
 * for a pad. Striking a pad plays its sound (no synthesis on the hit, so it
 * sounds at once), and a rhythm sketch is rendered by mixing the sounds at
 * its hits, so what was heard while tapping is what the canvas plays.
 */
import { encodeWav16 } from '../audio/wav';
import { padSample, PADS, playSeconds, rhythmHits, type RhythmPattern } from './rhythm';

/**
 * A library sample's sound (rendered with its settings) at a sample rate, or
 * null when it is gone: the pad then plays its own sound.
 */
export type PadSampleSource = (id: string, sampleRate: number) => Promise<Float32Array | null>;

/** Length of each one-shot (seconds). */
const SAMPLE_SECONDS = 0.6;
/** Ring-out after the last step of a rendered rhythm (seconds). */
export const RHYTHM_TAIL = 0.6;
/** Level of the pads in the mix (they are struck at full level). */
const KIT_GAIN = 0.7;

type OfflineCtor = typeof OfflineAudioContext;

function offlineClass(): OfflineCtor | null {
  return (
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: OfflineCtor }).webkitOfflineAudioContext ??
    null
  );
}

function render(ctx: OfflineAudioContext): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    ctx.oncomplete = (event) => resolve(event.renderedBuffer);
    // Older WebKit returns undefined and only fires `oncomplete`.
    const result = ctx.startRendering() as Promise<AudioBuffer> | undefined;
    result?.then(resolve, reject);
  });
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed seed: every rendering of a pad is the same.
  let seed = 22222;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 16807) % 2147483647;
    data[i] = (seed / 2147483647) * 2 - 1;
  }
  return buffer;
}

/** Schedule one pad hit on any context (used to make the samples). */
function voice(ctx: BaseAudioContext, out: AudioNode, pad: number, when: number) {
  if (pad === 0) {
    // Kick: a sine falling from 150 to 45 Hz, with a short click.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.003);
    g.gain.setTargetAtTime(0, when + 0.02, 0.11);
    osc.connect(g).connect(out);
    osc.start(when);
    osc.stop(when + SAMPLE_SECONDS);
    const click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx, 0.01);
    const cg = ctx.createGain();
    cg.gain.value = 0.25;
    click.connect(cg).connect(out);
    click.start(when);
  } else if (pad === 1) {
    // Snare: band-passed noise over a short tone.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.35);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, when);
    ng.gain.linearRampToValueAtTime(0.7, when + 0.002);
    ng.gain.setTargetAtTime(0, when + 0.01, 0.055);
    noise.connect(hp).connect(ng).connect(out);
    noise.start(when);
    const tone = ctx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220, when);
    tone.frequency.exponentialRampToValueAtTime(160, when + 0.08);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, when);
    tg.gain.linearRampToValueAtTime(0.55, when + 0.002);
    tg.gain.setTargetAtTime(0, when + 0.01, 0.04);
    tone.connect(tg).connect(out);
    tone.start(when);
    tone.stop(when + 0.3);
  } else if (pad === 3) {
    // Clap: three quick bursts of band-passed noise, then a short tail.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    for (const [k, at] of [0, 0.011, 0.022].entries()) {
      g.gain.setValueAtTime(0, when + at);
      g.gain.linearRampToValueAtTime(k === 2 ? 0.9 : 0.7, when + at + 0.001);
      g.gain.setTargetAtTime(0.05, when + at + 0.002, 0.003);
    }
    g.gain.setValueAtTime(0.8, when + 0.034);
    g.gain.setTargetAtTime(0, when + 0.035, 0.05);
    noise.connect(bp).connect(g).connect(out);
    noise.start(when);
  } else {
    // Hi-hat: high-passed noise, short.
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, 0.15);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.45, when + 0.001);
    g.gain.setTargetAtTime(0, when + 0.005, 0.022);
    noise.connect(hp).connect(g).connect(out);
    noise.start(when);
  }
}

const samples = new Map<number, Promise<Float32Array<ArrayBuffer>[]>>();

/** The pads' own one-shots at `sampleRate` (rendered once, then cached). */
export function drumSamples(sampleRate: number): Promise<Float32Array<ArrayBuffer>[]> {
  let pending = samples.get(sampleRate);
  if (!pending) {
    pending = (async () => {
      const Offline = offlineClass();
      if (!Offline) throw new Error('Offline audio rendering is not available here');
      const out: Float32Array<ArrayBuffer>[] = [];
      for (let pad = 0; pad < PADS.length; pad++) {
        const ctx = new Offline(1, Math.ceil(SAMPLE_SECONDS * sampleRate), sampleRate);
        voice(ctx, ctx.destination, pad, 0);
        out.push((await render(ctx)).getChannelData(0).slice());
      }
      return out;
    })();
    pending.catch(() => samples.delete(sampleRate));
    samples.set(sampleRate, pending);
  }
  return pending;
}

/**
 * Mix a rhythm as it plays on the canvas (its pattern repeated over
 * `lengthBars`), plus a ring-out, from the pads' one-shots. Pure, so it can
 * be tested without audio.
 */
export function mixRhythm(pattern: RhythmPattern, pads: Float32Array[], sampleRate: number): Float32Array<ArrayBuffer> {
  const length = Math.ceil((playSeconds(pattern) + RHYTHM_TAIL) * sampleRate);
  const out = new Float32Array(length);
  for (const hit of rhythmHits(pattern)) {
    const sample = pads[hit.pad];
    if (!sample) continue;
    const at = Math.round(hit.time * sampleRate);
    const gain = hit.level * KIT_GAIN;
    const n = Math.min(sample.length, length - at);
    for (let i = 0; i < n; i++) out[at + i] += sample[i] * gain;
  }
  // Several pads at once can pass full scale; the engine's limiter catches the rest.
  return out;
}

/** What each pad of `pattern` sounds like at `sampleRate`: its sample from the library, or its own sound. */
export async function padSounds(pattern: RhythmPattern, sampleRate: number, samples?: PadSampleSource): Promise<Float32Array[]> {
  const own = await drumSamples(sampleRate);
  return Promise.all(
    own.map(async (sound, pad) => {
      const id = padSample(pattern, pad);
      if (!id || !samples) return sound;
      try {
        return (await samples(id, sampleRate)) ?? sound;
      } catch {
        return sound;
      }
    }),
  );
}

/** A rhythm as it plays on the canvas, as a 16-bit WAV (scaled down only if it would clip). */
export async function rhythmToWav(pattern: RhythmPattern, sampleRate = 44100, samples?: PadSampleSource): Promise<Uint8Array> {
  const mixed = mixRhythm(pattern, await padSounds(pattern, sampleRate, samples), sampleRate);
  let peak = 0;
  for (const v of mixed) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.98) for (let i = 0; i < mixed.length; i++) mixed[i] *= 0.98 / peak;
  return encodeWav16([mixed], sampleRate);
}

/** A rhythm rendered into a buffer for `ctx` (what the canvas plays). */
export async function renderRhythm(ctx: BaseAudioContext, pattern: RhythmPattern, samples?: PadSampleSource): Promise<AudioBuffer> {
  const pads = await padSounds(pattern, ctx.sampleRate, samples);
  const mixed = mixRhythm(pattern, pads, ctx.sampleRate);
  const buffer = ctx.createBuffer(1, Math.max(1, mixed.length), ctx.sampleRate);
  buffer.copyToChannel(mixed, 0);
  return buffer;
}

/** Live pads on a running context: strike them while tapping, and preview patterns. */
export class DrumKit {
  private buffers: AudioBuffer[] | null = null;
  /** Library samples played instead of pads' own sounds. */
  private overrides: (AudioBuffer | null)[] = [];
  private readonly out: GainNode;
  readonly ready: Promise<void>;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode = ctx.destination,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = KIT_GAIN;
    this.out.connect(destination);
    this.ready = drumSamples(ctx.sampleRate).then((pads) => {
      this.buffers = pads.map((data) => {
        const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
        b.copyToChannel(data, 0);
        return b;
      });
    });
  }

  /** Pad `pad` plays this sound instead of its own (null: its own again). */
  setPadSound(pad: number, sound: Float32Array | null) {
    if (!sound || sound.length === 0) {
      this.overrides[pad] = null;
      return;
    }
    const b = this.ctx.createBuffer(1, sound.length, this.ctx.sampleRate);
    b.copyToChannel(sound as Float32Array<ArrayBuffer>, 0);
    this.overrides[pad] = b;
  }

  /** Strike `pad` at `when` (audio-clock time; default now). */
  hit(pad: number, when = 0, level = 1): AudioBufferSourceNode | null {
    const buffer = this.overrides[pad] ?? this.buffers?.[pad];
    if (!buffer) {
      // Not rendered yet (the first moment after opening): synthesize this one.
      voice(this.ctx, this.out, pad, Math.max(when, this.ctx.currentTime));
      return null;
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    let node: AudioNode = source;
    if (level < 1) {
      const g = this.ctx.createGain();
      g.gain.value = level;
      source.connect(g);
      node = g;
    }
    node.connect(this.out);
    source.start(Math.max(when, this.ctx.currentTime));
    return source;
  }

  dispose() {
    try {
      this.out.disconnect();
    } catch {
      // already disconnected
    }
  }
}
