/**
 * A small Web Audio piano-ish synth.
 *  - `NoteSynth` plays transcribed notes in step with playback: it follows
 *    the playback engine's clock mapping on the same audio context, so its
 *    notes land exactly with the recordings. It also previews single notes
 *    and plays chords.
 *  - `renderNotesToWav` renders notes offline with the same voice, for export.
 */
import { encodeWav16 } from '../audio/wav';
import type { PianoNote } from '../transcription/types';
import { notesEndTime, sortNotes } from './notes';

interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
  start: number;
  end: number;
}

/** Seconds of timeline scheduled ahead of the clock. */
const LOOKAHEAD = 0.25;
/** Voices sounding at once; past this the oldest is faded out (keeps dense, multi-track passages from overloading the audio thread). */
const MAX_VOICES = 48;

/** Which timeline position sounds at which audio-clock time (see `ClockMapping` in the playback engine). */
export interface SynthClock {
  position: number;
  time: number;
  rate: number;
  /** End of the pass on the timeline: no note starts at or after it. */
  until: number | null;
}

export interface NoteSynthOptions {
  /** The audio context to play in (the playback engine's), instead of one of its own. */
  context?: () => AudioContext;
  /** Where its output goes (the engine's mix bus) instead of the speakers. */
  destination?: () => AudioNode;
}

type Ctx = BaseAudioContext;

function audioContextClass(): typeof AudioContext {
  return (
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

/** Schedule one piano-like note on any (real-time or offline) context. */
export function scheduleVoice(
  ctx: Ctx,
  destination: AudioNode,
  pitch: number,
  velocity: number,
  when: number,
  length: number,
): Voice {
  const f0 = 440 * 2 ** ((pitch - 69) / 12);
  const peak = 0.08 + 0.32 * (Math.min(127, Math.max(1, velocity)) / 127) ** 1.5;
  // Lower notes ring longer, like strings.
  const decay = 0.4 + 2.2 * Math.max(0, (96 - pitch) / 75);
  const release = 0.12;
  const hold = Math.max(0.05, length);
  const end = when + hold + release;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.006);
  gain.gain.setTargetAtTime(peak * 0.25, when + 0.006, decay / 3);
  gain.gain.setTargetAtTime(0, when + hold, release / 3);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(Math.min(12000, f0 * 10), when);
  filter.frequency.setTargetAtTime(Math.min(6000, f0 * 3), when, 0.3);
  filter.connect(gain).connect(destination);

  const partials: [OscillatorType, number, number][] = [
    ['triangle', 1, 1],
    ['sine', 2, 0.35],
    ['sine', 3, 0.12],
  ];
  const oscillators = partials.map(([type, multiple, level]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = f0 * multiple;
    const g = ctx.createGain();
    g.gain.value = level;
    osc.connect(g).connect(filter);
    osc.start(when);
    osc.stop(end + 0.05);
    return osc;
  });
  return { oscillators, gain, start: when, end };
}

function createOutput(ctx: Ctx, volume: number, destination: AudioNode = ctx.destination): GainNode {
  const master = ctx.createGain();
  master.gain.value = volume;
  const compressor = ctx.createDynamicsCompressor();
  master.connect(compressor).connect(destination);
  return master;
}

export class NoteSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private notes: PianoNote[] = [];
  private nextIndex = 0;
  private volume = 0.6;
  private voices: Voice[] = [];
  /** The clock being followed while playing; null when stopped. */
  private clock: SynthClock | null = null;

  constructor(private readonly options: NoteSynthOptions = {}) {}

  setNotes(notes: PianoNote[]) {
    this.notes = sortNotes(notes);
    const clock = this.clock;
    if (clock && this.ctx) {
      // Start again from what is playing now, with the new notes.
      this.stopVoices(0.03);
      this.nextIndex = this.firstIndexAtOrAfter(this.positionAt(Math.max(this.ctx.currentTime, clock.time)));
      this.pump();
    }
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  get running(): boolean {
    return this.clock !== null;
  }

  /**
   * Create or wake the audio context. Call it synchronously inside the tap or
   * key press that should lead to notes sounding: Safari and the iOS and
   * macOS web views only let an audio context start during a user gesture,
   * and leave `resume()` pending outside one.
   */
  unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'running') return;
    void ctx.resume().catch(() => {});
    // Older WebKit also wants a sound started in the gesture: one silent sample.
    try {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // not needed where resume() suffices
    }
  }

  /**
   * Follow `clock` (null: stop). A clock that takes over in the future (the
   * next pass of a loop) lets the notes before the switch play out first.
   */
  cue(clock: SynthClock | null) {
    if (!clock) {
      this.stop();
      return;
    }
    const ctx = this.ensureContext();
    const previous = this.clock;
    if (previous && clock.time > ctx.currentTime) {
      // Everything the old pass still has to play before the switch, then cut what rings past it.
      this.scheduleUntil(previous, this.positionAt(clock.time, previous), clock.time);
      this.cutAt(clock.time);
    } else {
      this.stopVoices(0.02);
    }
    this.clock = clock;
    // From the pass's start, or from now when it is already under way (notes switched on mid-playback).
    this.nextIndex = this.firstIndexAtOrAfter(Math.max(clock.position, this.positionAt(ctx.currentTime, clock)));
    this.pump();
  }

  /** Schedule the notes coming up (call every animation frame while playing). */
  pump() {
    const ctx = this.ctx;
    const clock = this.clock;
    if (!ctx || !clock) return;
    const now = this.positionAt(Math.max(ctx.currentTime, clock.time));
    this.scheduleUntil(clock, now + LOOKAHEAD * clock.rate, Infinity);
  }

  stop() {
    this.clock = null;
    this.stopVoices(0.05);
  }

  /** Play a single note immediately (editor feedback). */
  preview(pitch: number, velocity = 90) {
    this.playNow([pitch], velocity, 0.6);
  }

  /** Play several notes together, e.g. a chord from the chord strip. */
  playChord(pitches: number[], velocity = 80, length = 1.4, spread = 0.012) {
    // Slight roll from the bass up, like a pianist's hand.
    this.playNow([...pitches].sort((a, b) => a - b), velocity, length, spread);
  }

  dispose() {
    this.stop();
    // A shared context belongs to the playback engine.
    if (!this.options.context) void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private playNow(pitches: number[], velocity: number, length: number, spread = 0) {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const at = ctx.currentTime + 0.01;
    pitches.forEach((pitch, i) => {
      this.addVoice(scheduleVoice(ctx, this.master!, pitch, velocity, at + i * spread, length));
    });
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const shared = this.options.context?.();
      this.ctx = shared ?? new (audioContextClass())({ latencyHint: 'playback' });
      this.master = createOutput(this.ctx, this.volume, this.options.destination?.());
    }
    return this.ctx;
  }

  /** Timeline position at audio time `time` under `clock`. */
  private positionAt(time: number, clock = this.clock): number {
    if (!clock) return 0;
    return clock.position + (time - clock.time) * clock.rate;
  }

  private firstIndexAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].startTime < t - 0.01) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Schedule notes of `clock` that start before timeline `horizon`, and at audio times before `latest`. */
  private scheduleUntil(clock: SynthClock, horizon: number, latest: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const limit = clock.until === null ? horizon : Math.min(horizon, clock.until);
    const endTime = clock.until === null ? Infinity : clock.time + (clock.until - clock.position) / clock.rate;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].startTime < limit) {
      const note = this.notes[this.nextIndex++];
      const when = clock.time + (note.startTime - clock.position) / clock.rate;
      if (when < ctx.currentTime - 0.05 || when >= latest) continue;
      // A note is cut at the end of the pass (crop end).
      const length = Math.min(note.endTime - note.startTime, Math.max(0.02, (endTime - when) * clock.rate)) / clock.rate;
      this.addVoice(scheduleVoice(ctx, this.master!, note.pitch, note.velocity, Math.max(when, ctx.currentTime), length));
    }
  }

  private addVoice(voice: Voice) {
    const now = this.ctx?.currentTime ?? 0;
    this.voices = this.voices.filter((v) => v.end > now);
    this.voices.push(voice);
    // Too many at once: fade out the oldest of those still sounding when this one starts.
    const sounding = this.voices.filter((v) => v.start <= voice.start && v.end > voice.start);
    if (sounding.length > MAX_VOICES) {
      const oldest = sounding.reduce((a, b) => (b.start < a.start ? b : a));
      this.fadeVoice(oldest, voice.start, 0.03);
      this.voices = this.voices.filter((v) => v !== oldest);
    }
  }

  /** Voices still sounding at audio time `t` stop there; those starting after it never sound. */
  private cutAt(t: number) {
    const keep: Voice[] = [];
    for (const v of this.voices) {
      if (v.end <= t) keep.push(v);
      else this.fadeVoice(v, Math.max(t, v.start), 0.02);
    }
    this.voices = keep;
  }

  private fadeVoice(v: Voice, at: number, fade: number) {
    if (v.start >= at) {
      // Not started yet: it never sounds. (Cancelling its envelope instead would leave the gain at 1.)
      for (const osc of v.oscillators) {
        try {
          osc.stop(v.start);
        } catch {
          // already stopped
        }
      }
      return;
    }
    v.gain.gain.cancelScheduledValues(at);
    v.gain.gain.setTargetAtTime(0, at, fade / 3);
    for (const osc of v.oscillators) {
      try {
        osc.stop(at + fade * 2);
      } catch {
        // already stopped
      }
    }
  }

  private stopVoices(fade: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) this.fadeVoice(v, now, fade);
    this.voices = [];
  }
}

/** Render notes offline with the synth voice and return a 16-bit WAV. */
export async function renderNotesToWav(
  notes: PianoNote[],
  options: { sampleRate?: number; tail?: number; volume?: number } = {},
): Promise<Uint8Array> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = Math.max(0.5, notesEndTime(notes) + (options.tail ?? 1.5));
  const OfflineCtx: typeof OfflineAudioContext =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error('Offline audio rendering is not available here');
  const ctx = new OfflineCtx(1, Math.ceil(seconds * sampleRate), sampleRate);
  const master = createOutput(ctx, options.volume ?? 0.6);
  for (const note of sortNotes(notes)) {
    scheduleVoice(ctx, master, note.pitch, note.velocity, note.startTime, note.endTime - note.startTime);
  }
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    ctx.oncomplete = (event) => resolve(event.renderedBuffer);
    // Older WebKit returns undefined and only fires `oncomplete`.
    const result = ctx.startRendering() as Promise<AudioBuffer> | undefined;
    result?.then(resolve, reject);
  });
  return encodeWav16([buffer.getChannelData(0)], sampleRate);
}
