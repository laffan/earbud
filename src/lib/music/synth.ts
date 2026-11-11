/**
 * A small Web Audio piano-ish synth.
 *  - `NoteSynth` plays transcribed notes in sync with an external media clock
 *    (the <video> element), previews single notes and plays chords.
 *  - `renderNotesToWav` renders notes offline with the same voice, for export.
 */
import { encodeWav16 } from '../audio/wav';
import type { PianoNote } from '../transcription/types';
import { notesEndTime, sortNotes } from './notes';

interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
  end: number;
}

/** Seconds of media time scheduled ahead of the clock. */
const LOOKAHEAD = 0.25;
/** Disagreement with the media clock that is ignored (coarse/jittery video clocks). */
const TOLERANCE = 0.3;
/** How long a moderate disagreement must persist before rescheduling. */
const PERSISTENCE = 0.25;
/** Jumps larger than this are seeks and are followed immediately. */
const JUMP = 1.0;
/** Output latency allowance when anchoring. */
const START_OFFSET = 0.03;

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
  return { oscillators, gain, end };
}

function createOutput(ctx: Ctx, volume: number): GainNode {
  const master = ctx.createGain();
  master.gain.value = volume;
  const compressor = ctx.createDynamicsCompressor();
  master.connect(compressor).connect(ctx.destination);
  return master;
}

export class NoteSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private notes: PianoNote[] = [];
  private nextIndex = 0;
  private volume = 0.6;
  private voices: Voice[] = [];

  /** Playback requested (between start() and stop()). */
  private active = false;
  private rate = 1;
  /** Media time ↔ audio time mapping; null until the audio clock runs. */
  private anchor: { media: number; ctx: number } | null = null;
  /** Audio clock value when start() was called (to detect a running clock). */
  private clockAtStart = 0;
  /** When the current moderate disagreement began (audio time), if any. */
  private driftSince: number | null = null;

  setNotes(notes: PianoNote[]) {
    this.notes = sortNotes(notes);
    if (this.anchor) this.reschedule(this.mediaTimeNow());
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  get running(): boolean {
    return this.active;
  }

  /**
   * Start following the media clock from `mediaTime`. Must be called from a
   * user gesture the first time (autoplay policy). Notes are scheduled once
   * the audio clock is actually running (a new context can take a moment).
   */
  async start(mediaTime: number, rate = 1) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // will retry on the next gesture
      }
    }
    this.stopVoices(0.02);
    this.active = true;
    this.rate = rate;
    this.anchor = null;
    this.driftSince = null;
    this.clockAtStart = ctx.currentTime;
    this.tick(mediaTime, rate);
  }

  /** Call regularly (each animation frame) with the media clock. */
  tick(mediaTime: number, rate = 1) {
    const ctx = this.ctx;
    if (!this.active || !ctx) return;

    if (!this.anchor) {
      // Wait until the audio clock has demonstrably started.
      if (ctx.state !== 'running' || ctx.currentTime <= this.clockAtStart) return;
      this.rate = rate;
      this.reschedule(mediaTime);
      return;
    }
    if (rate !== this.rate) {
      this.rate = rate;
      this.reschedule(mediaTime);
      return;
    }

    const predicted = this.mediaTimeNow();
    const error = mediaTime - predicted;
    if (Math.abs(error) > JUMP) {
      this.reschedule(mediaTime); // a seek
      return;
    }
    if (Math.abs(error) > TOLERANCE) {
      // Persistent disagreement (stall, clock problem): follow the media clock.
      this.driftSince ??= ctx.currentTime;
      if (ctx.currentTime - this.driftSince >= PERSISTENCE) {
        this.reschedule(mediaTime);
        return;
      }
    } else {
      this.driftSince = null;
    }
    // Schedule from the synth's own smooth clock, not the (possibly coarse) video clock.
    this.schedule(predicted);
  }

  stop() {
    this.active = false;
    this.anchor = null;
    this.stopVoices(0.05);
  }

  /** Play a single note immediately (editor feedback). */
  preview(pitch: number, velocity = 90) {
    this.playNow([pitch], velocity, 0.6);
  }

  /** Play several notes together, e.g. a chord from the chord strip. */
  playChord(pitches: number[], velocity = 80, length = 1.4) {
    // Slight roll from the bass up, like a pianist's hand.
    this.playNow([...pitches].sort((a, b) => a - b), velocity, length, 0.012);
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private playNow(pitches: number[], velocity: number, length: number, spread = 0) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const at = ctx.currentTime + 0.01;
    pitches.forEach((pitch, i) => {
      this.voices.push(scheduleVoice(ctx, this.master!, pitch, velocity, at + i * spread, length));
    });
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctx = audioContextClass();
      this.ctx = new Ctx({ latencyHint: 'playback' });
      this.master = createOutput(this.ctx, this.volume);
    }
    return this.ctx;
  }

  private mediaTimeNow(): number {
    if (!this.anchor || !this.ctx) return 0;
    return this.anchor.media + (this.ctx.currentTime - this.anchor.ctx) * this.rate;
  }

  /** Drop scheduled voices and restart scheduling from `mediaTime`. */
  private reschedule(mediaTime: number) {
    if (!this.ctx) return;
    this.stopVoices(0.03);
    this.anchor = { media: mediaTime, ctx: this.ctx.currentTime + START_OFFSET };
    this.driftSince = null;
    this.nextIndex = this.firstIndexAtOrAfter(mediaTime);
    this.schedule(mediaTime);
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

  private schedule(mediaTime: number) {
    const ctx = this.ctx;
    const anchor = this.anchor;
    if (!ctx || !anchor) return;
    const horizon = mediaTime + LOOKAHEAD * this.rate;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].startTime < horizon) {
      const note = this.notes[this.nextIndex++];
      const when = anchor.ctx + (note.startTime - anchor.media) / this.rate;
      if (when < ctx.currentTime - 0.05) continue;
      const length = (note.endTime - note.startTime) / this.rate;
      this.voices.push(
        scheduleVoice(ctx, this.master!, note.pitch, note.velocity, Math.max(when, ctx.currentTime), length),
      );
    }
    const now = ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
  }

  private stopVoices(fade: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, fade / 3);
      for (const osc of v.oscillators) {
        try {
          osc.stop(now + fade * 2);
        } catch {
          // already stopped
        }
      }
    }
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
