/**
 * Count-in before a take: a few metronome ticks, then the downbeat.
 *
 * The ticks are short bursts of filtered noise rather than tones. The
 * microphone hears them, and an unpitched tick far shorter than Basic
 * Pitch's minimum note length (~128 ms) does not turn into a note.
 *
 * `prepare()` must be called from the tap that starts the recording: iOS
 * only lets an AudioContext start during a user gesture. Without a running
 * context the count-in is still shown, just silent.
 */

export interface CountInOptions {
  beats: number;
  bpm: number;
  /** Called on each beat, 1-based, as it sounds. */
  onBeat: (beat: number) => void;
  /** Stop early (the user stopped or cancelled the take). */
  signal?: AbortSignal;
  /** Milliseconds clock (tests). */
  now?: () => number;
  /** Timer (tests). */
  setTimer?: (callback: () => void, ms: number) => unknown;
}

type Ctx = AudioContext;

function audioContextClass(): typeof AudioContext | null {
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ??
    null
  );
}

/** Lead time before the first tick, so it is scheduled cleanly (seconds). */
const LEAD = 0.12;

export class Metronome {
  private ctx: Ctx | null = null;
  private noise: AudioBuffer | null = null;

  /** Create (or wake) the audio context. Call synchronously inside the user's tap. */
  prepare() {
    try {
      if (!this.ctx) {
        const Ctx = audioContextClass();
        if (!Ctx) return;
        this.ctx = new Ctx({ latencyHint: 'interactive' });
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  /** Whether ticks will be heard (the context is running). */
  get audible(): boolean {
    return this.ctx?.state === 'running';
  }

  /** The audio clock (seconds), while it runs. */
  get time(): number | null {
    return this.ctx?.state === 'running' ? this.ctx.currentTime : null;
  }

  /** A tick at `when` on the audio clock. */
  tickAt(when: number, accent = false) {
    if (this.ctx) this.tick(this.ctx, when, accent);
  }

  /**
   * Count `beats` beats at `bpm` and resolve at the downbeat that follows
   * them: true if it got there, false if `signal` aborted first.
   */
  run(options: CountInOptions): Promise<boolean> {
    const now = options.now ?? (() => performance.now());
    const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
    const period = 60 / Math.max(20, Math.min(300, options.bpm));
    const ctx = this.audible ? this.ctx : null;
    const startCtx = ctx ? ctx.currentTime + LEAD : 0;
    const startWall = now() + LEAD * 1000;
    if (ctx) {
      for (let i = 0; i < options.beats; i++) this.tick(ctx, startCtx + i * period, i === 0);
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        resolve(ok);
      };
      options.signal?.addEventListener('abort', () => finish(false), { once: true });
      if (options.signal?.aborted) {
        finish(false);
        return;
      }
      // Visual beats and the downbeat on the wall clock (the ticks are on the audio clock).
      for (let i = 0; i <= options.beats; i++) {
        const at = startWall + i * period * 1000;
        setTimer(() => {
          if (done) return;
          if (i < options.beats) options.onBeat(i + 1);
          else finish(true);
        }, Math.max(0, at - now()));
      }
    });
  }

  /** Release the audio hardware (until the next `prepare`). */
  close() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.noise = null;
  }

  private tick(ctx: Ctx, when: number, accent: boolean) {
    if (!this.noise) {
      const length = Math.round(ctx.sampleRate * 0.03);
      this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = accent ? 4200 : 3000;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(accent ? 1 : 0.7, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.025);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(when);
    source.stop(when + 0.03);
  }
}

/**
 * Metronome ticks that follow playback (a media clock), on a grid of `bpm`
 * through `beat` (seconds of sketch time). Scheduled a little ahead on the
 * audio clock from a smooth mapping of media time to audio time, which is
 * reset after a seek or when the two clocks disagree by more than 80 ms.
 */
export class ClickTrack {
  private grid: { bpm: number; beat: number } | null = null;
  private anchor: { media: number; ctx: number } | null = null;
  private next = 0;
  private active = false;

  constructor(private readonly metronome = new Metronome()) {}

  setGrid(bpm: number | null, beat: number | null) {
    this.grid = bpm && bpm > 0 ? { bpm, beat: beat ?? 0 } : null;
    this.anchor = null;
  }

  /** Begin following playback. Call from a tap the first time (iOS starts audio only then). */
  start() {
    this.metronome.prepare();
    this.active = true;
    this.anchor = null;
  }

  /** Every animation frame while playing. */
  tick(position: number, rate: number) {
    const now = this.metronome.time;
    const grid = this.grid;
    if (!this.active || now === null || !grid || rate <= 0) return;
    const period = 60 / grid.bpm;
    const predicted = this.anchor ? this.anchor.media + (now - this.anchor.ctx) * rate : NaN;
    if (!this.anchor || !(Math.abs(predicted - position) <= 0.08)) {
      this.anchor = { media: position, ctx: now + 0.03 };
      this.next = grid.beat + Math.ceil((position - grid.beat) / period) * period;
    }
    const mediaNow = this.anchor.media + (now - this.anchor.ctx) * rate;
    while (this.next < mediaNow + 0.15 * rate) {
      const when = this.anchor.ctx + (this.next - this.anchor.media) / rate;
      if (when >= now - 0.01) this.metronome.tickAt(Math.max(when, now));
      this.next += period;
    }
  }

  /** Playback paused or jumped: the next tick is worked out afresh. */
  stop() {
    this.active = false;
    this.anchor = null;
  }

  dispose() {
    this.stop();
    this.metronome.close();
  }
}
