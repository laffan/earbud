/**
 * How a library sample plays: its trim, envelope, effects and root note.
 * The stored audio is never changed; these settings are applied when the
 * sample is rendered (`render.ts`). The JS steps here (trim, reverse,
 * normalize, envelope, level) are pure and unit tested; filters, reverb and
 * transposition are rendered with Web Audio.
 */

export interface SampleSettings {
  version: 1;
  /** Trim: where it starts and ends in the stored audio (seconds; end null = its end). */
  start: number;
  end: number | null;
  /** Level (dB). */
  gainDb: number;
  /** Fade in (seconds). */
  attack: number;
  /** Seconds the sound takes to die away after the attack (0 = as recorded). */
  decay: number;
  /** Fade out at the end (seconds). */
  release: number;
  /** Reverb: how much (0–1), and how long the room rings (seconds). */
  reverb: number;
  reverbSize: number;
  /** Low-pass and high-pass cutoffs (Hz; null = off). */
  lowpassHz: number | null;
  highpassHz: number | null;
  /** Transposed by this many semitones (and so faster or slower). */
  pitch: number;
  reverse: boolean;
  /** Brought up (or down) to just under full scale before the level is applied. */
  normalize: boolean;
  /** The note it sounds at (MIDI), for playing notes with it; null = unknown (C4 is assumed). */
  rootPitch: number | null;
  /** How far from that note it sounds (cents), so notes played with it are in tune. */
  fineCents: number;
  /** Where the root came from: detected from the sound, or set by hand (kept by "detect again"). */
  rootSource: 'detected' | 'user' | null;
}

export const DEFAULT_SAMPLE_SETTINGS: SampleSettings = {
  version: 1,
  start: 0,
  end: null,
  gainDb: 0,
  attack: 0.003,
  decay: 0,
  release: 0.01,
  reverb: 0,
  reverbSize: 1.6,
  lowpassHz: null,
  highpassHz: null,
  pitch: 0,
  reverse: false,
  normalize: false,
  rootPitch: null,
  fineCents: 0,
  rootSource: null,
};

export const LIMITS = {
  gainDb: [-24, 12],
  attack: [0, 1],
  decay: [0, 8],
  release: [0, 2],
  reverb: [0, 1],
  reverbSize: [0.2, 5],
  lowpassHz: [200, 20000],
  highpassHz: [20, 4000],
  pitch: [-24, 24],
  rootPitch: [21, 108],
  fineCents: [-50, 50],
} as const;

/** Note assumed for a sample without a root. */
export const DEFAULT_ROOT = 60;

const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, x));
const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback);

/** Settings read from storage, made safe to use. */
export function normalizeSampleSettings(raw: unknown): SampleSettings {
  const r = raw && typeof raw === 'object' ? (raw as Partial<SampleSettings>) : {};
  const d = DEFAULT_SAMPLE_SETTINGS;
  const start = Math.max(0, num(r.start, 0));
  const end = r.end === null || r.end === undefined ? null : Math.max(start + 0.01, num(r.end, start + 0.01));
  const optionalHz = (x: unknown, limits: readonly [number, number]) =>
    typeof x === 'number' && Number.isFinite(x) ? clamp(x, limits) : null;
  return {
    version: 1,
    start,
    end,
    gainDb: clamp(num(r.gainDb, d.gainDb), LIMITS.gainDb),
    attack: clamp(num(r.attack, d.attack), LIMITS.attack),
    decay: clamp(num(r.decay, d.decay), LIMITS.decay),
    release: clamp(num(r.release, d.release), LIMITS.release),
    reverb: clamp(num(r.reverb, d.reverb), LIMITS.reverb),
    reverbSize: clamp(num(r.reverbSize, d.reverbSize), LIMITS.reverbSize),
    lowpassHz: optionalHz(r.lowpassHz, LIMITS.lowpassHz),
    highpassHz: optionalHz(r.highpassHz, LIMITS.highpassHz),
    pitch: Math.round(clamp(num(r.pitch, 0), LIMITS.pitch)),
    reverse: r.reverse === true,
    normalize: r.normalize === true,
    rootPitch: typeof r.rootPitch === 'number' && Number.isFinite(r.rootPitch) ? Math.round(clamp(r.rootPitch, LIMITS.rootPitch)) : null,
    fineCents: Math.round(clamp(num(r.fineCents, 0), LIMITS.fineCents)),
    rootSource: r.rootSource === 'detected' || r.rootSource === 'user' ? r.rootSource : null,
  };
}

/** The pitch notes are played from (fractional MIDI): its root, tuning and transposition. */
export function playedRoot(settings: SampleSettings): number {
  return (settings.rootPitch ?? DEFAULT_ROOT) + settings.fineCents / 100 + settings.pitch;
}

/** The playback rate that makes a sample whose root is `root` sound `pitch` (both MIDI). */
export function rateFor(root: number, pitch: number): number {
  return 2 ** ((pitch - root) / 12);
}

/** The trimmed span of a sound `duration` seconds long: [from, to). */
export function trimSpan(settings: SampleSettings, duration: number): { from: number; to: number } {
  const from = Math.min(Math.max(0, settings.start), Math.max(0, duration - 0.005));
  const to = Math.max(from + 0.005, Math.min(duration, settings.end ?? duration));
  return { from, to };
}

/**
 * The envelope's gain at `t` seconds into a sound `length` seconds long:
 * a linear fade in over `attack`, then (with a decay) an exponential fall to
 * about −35 dB over `decay` seconds, and a linear fade out over the last
 * `release` seconds.
 */
export function envelopeAt(t: number, length: number, settings: Pick<SampleSettings, 'attack' | 'decay' | 'release'>): number {
  if (t < 0 || t > length) return 0;
  let g = 1;
  if (settings.attack > 0 && t < settings.attack) g *= t / settings.attack;
  if (settings.decay > 0 && t > settings.attack) g *= Math.exp((-4 * (t - settings.attack)) / settings.decay);
  const release = Math.min(settings.release, length);
  if (release > 0 && t > length - release) g *= Math.max(0, (length - t) / release);
  return g;
}

/**
 * The JS part of rendering, on one channel: trim, reverse, normalize,
 * envelope and level. Filters, reverb and transposition follow in Web Audio.
 */
export function shapeSample(samples: Float32Array, sampleRate: number, settings: SampleSettings): Float32Array<ArrayBuffer> {
  const duration = samples.length / sampleRate;
  const { from, to } = trimSpan(settings, duration);
  const a = Math.floor(from * sampleRate);
  const b = Math.max(a + 1, Math.min(samples.length, Math.round(to * sampleRate)));
  const out = new Float32Array(b - a);
  out.set(samples.subarray(a, b));
  if (settings.reverse) out.reverse();
  let scale = 10 ** (settings.gainDb / 20);
  if (settings.normalize) {
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 1e-5) scale *= 0.89 / peak; // −1 dBFS
  }
  const length = out.length / sampleRate;
  for (let i = 0; i < out.length; i++) out[i] *= scale * envelopeAt(i / sampleRate, length, settings);
  return out;
}

/** Mix channels down to one. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0]?.length ?? 0);
  for (const channel of channels) for (let i = 0; i < out.length; i++) out[i] += channel[i] / channels.length;
  return out;
}

/** A title for a sample cut from a sketch at `seconds`. */
export function sampleTitle(sketchTitle: string, seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const at = `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${sketchTitle.trim() || 'Sample'} ${at}`.slice(0, 120);
}
