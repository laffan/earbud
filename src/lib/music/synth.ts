/**
 * A small Web Audio piano-ish synth that plays transcribed notes in sync with
 * an external media clock (the <video> element), so the transcription can be
 * auditioned against, or instead of, the original recording.
 */
import type { PianoNote } from '../transcription/types';
import { sortNotes } from './notes';

interface Voice {
  oscillators: OscillatorNode[];
  gain: GainNode;
  end: number;
}

const LOOKAHEAD = 0.25; // seconds of media time scheduled ahead
const RESYNC = 0.08; // drift that triggers a reschedule

export class NoteSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private notes: PianoNote[] = [];
  private nextIndex = 0;
  private anchor: { media: number; ctx: number; rate: number } | null = null;
  private voices: Voice[] = [];
  private volume = 0.6;

  setNotes(notes: PianoNote[]) {
    this.notes = sortNotes(notes);
    if (this.anchor) this.resync(this.mediaTimeNow());
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  get running(): boolean {
    return this.anchor !== null;
  }

  /** Must be called from a user gesture the first time (autoplay policy). */
  async start(mediaTime: number, rate = 1) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.stopVoices(0.02);
    this.anchor = { media: mediaTime, ctx: ctx.currentTime + 0.03, rate };
    this.nextIndex = this.firstIndexAtOrAfter(mediaTime);
    this.schedule(mediaTime);
  }

  /** Call regularly (each animation frame) with the media clock. */
  tick(mediaTime: number, rate = 1) {
    if (!this.anchor || !this.ctx) return;
    if (rate !== this.anchor.rate || Math.abs(this.mediaTimeNow() - mediaTime) > RESYNC) {
      this.anchor.rate = rate;
      this.resync(mediaTime);
      return;
    }
    this.schedule(mediaTime);
  }

  stop() {
    this.anchor = null;
    this.stopVoices(0.05);
  }

  /** Play a single note immediately (editor feedback). */
  preview(pitch: number, velocity = 90) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') void ctx.resume();
    this.voice(pitch, velocity, ctx.currentTime + 0.01, 0.6);
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'playback' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const compressor = this.ctx.createDynamicsCompressor();
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private mediaTimeNow(): number {
    if (!this.anchor || !this.ctx) return 0;
    return this.anchor.media + (this.ctx.currentTime - this.anchor.ctx) * this.anchor.rate;
  }

  private resync(mediaTime: number) {
    if (!this.ctx || !this.anchor) return;
    this.stopVoices(0.03);
    this.anchor = { media: mediaTime, ctx: this.ctx.currentTime + 0.03, rate: this.anchor.rate };
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
    if (!this.ctx || !this.anchor) return;
    const horizon = mediaTime + LOOKAHEAD * this.anchor.rate;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex].startTime < horizon) {
      const note = this.notes[this.nextIndex++];
      const when = this.anchor.ctx + (note.startTime - this.anchor.media) / this.anchor.rate;
      if (when < this.ctx.currentTime - 0.05) continue;
      const length = (note.endTime - note.startTime) / this.anchor.rate;
      this.voice(note.pitch, note.velocity, Math.max(when, this.ctx.currentTime), length);
    }
    const now = this.ctx.currentTime;
    this.voices = this.voices.filter((v) => v.end > now);
  }

  private voice(pitch: number, velocity: number, when: number, length: number) {
    const ctx = this.ctx!;
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    const peak = 0.08 + 0.32 * (velocity / 127) ** 1.5;
    // Lower notes ring longer, like strings.
    const decay = 0.4 + 2.2 * Math.max(0, (96 - pitch) / 75);
    const release = 0.12;
    const end = when + Math.max(0.05, length) + release;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.006);
    gain.gain.setTargetAtTime(peak * 0.25, when + 0.006, decay / 3);
    gain.gain.setTargetAtTime(0, when + Math.max(0.05, length), release / 3);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(12000, f0 * 10), when);
    filter.frequency.setTargetAtTime(Math.min(6000, f0 * 3), when, 0.3);
    filter.connect(gain).connect(this.master!);

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
    this.voices.push({ oscillators, gain, end });
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
