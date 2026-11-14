/**
 * Playback of a sketch's tracks through one Web Audio graph.
 *
 * Each track's recording is a decoded AudioBuffer. Playing starts one
 * buffer source per track, all scheduled against the same audio clock, so
 * the tracks stay sample-locked for as long as they play: there is nothing
 * to keep in step, unlike one media element per track (each with its own
 * clock and decoder, nudged by rate changes and seeks, which on WebKit means
 * one AVFoundation player per track). Mute, solo and the listen mode only
 * move a track's gain. Everything is summed through a limiter, so several
 * loud takes (and the synth, which plays into `input`) cannot clip.
 *
 * Time: a track's buffer time 0 lies at `offset` seconds on the sketch's
 * timeline. A `ClockMapping` says which timeline position sounds at which
 * audio-clock time; it changes on start, seek, loop and speed changes, and
 * followers on the same context (the synth) schedule from it exactly. The
 * position reported to the UI is the one being heard: the audio clock minus
 * the output latency.
 *
 * Slowed playback plays stretched copies of the buffers (made once per
 * speed, pitch kept), so the audio clock and the timeline still advance at a
 * fixed ratio. Crop ranges stop or loop exactly at their end; the next pass
 * of a loop is scheduled just before the end, so loops are gapless.
 */

export interface EngineTrack {
  id: string;
  /** The decoded recording; null while it loads or when it cannot be decoded. */
  buffer: AudioBuffer | null;
  /** Still being decoded. Playback waits for it only when no other track is ready. */
  loading: boolean;
  /** Timeline position of the buffer's time 0 (seconds). */
  offset: number;
  /** Its recording is heard (mute, solo, listen mode). */
  audible: boolean;
}

/** Timeline position `position` sounds at audio-clock time `time`; the timeline moves `rate` s per second. */
export interface ClockMapping {
  position: number;
  time: number;
  rate: number;
  /**
   * Where this pass ends on the timeline (crop end or the sketch's end), or
   * null. Updated in place when the crop changes while playing.
   */
  until: number | null;
}

export interface EngineState {
  /** The position being heard (seconds). */
  position: number;
  /** Playing, or about to (waiting for audio). */
  playing: boolean;
  /** Asked to play but no sound yet (decoding, stretching, or the audio context not running). */
  buffering: boolean;
}

export interface AudioEngineOptions {
  onState: (state: EngineState) => void;
  /** Every animation frame while playing, with the position being heard. */
  onFrame?: (position: number, rate: number) => void;
  /** The timeline-to-clock mapping changed (start, seek, loop, speed), or playback stopped (null). */
  onCue?: (mapping: ClockMapping | null) => void;
  log?: (message: string) => void;
  /** Creates the audio context (tests). */
  createContext?: () => AudioContext;
  /** A copy of a buffer that plays at `rate` with the pitch kept (slowed playback). */
  stretch?: (ctx: BaseAudioContext, buffer: AudioBuffer, rate: number) => Promise<AudioBuffer>;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  /** Interval of the timer that keeps playback going when animation frames are throttled (ms; 0 = none). */
  backstopMs?: number;
}

/** Sources start this long after they are scheduled (seconds of audio clock). */
const LEAD = 0.05;
/** Fade applied when sources stop (seconds). */
const FADE = 0.008;
/** The end of a pass (stop, or the loop's next pass) is scheduled this long before it (seconds). */
const AHEAD = 0.3;
/** A loop shorter than this is not looped (seconds). */
const MIN_LOOP = 0.25;
const END_EPSILON = 0.02;
/** Latency reported by the context is believed up to this (seconds). */
const MAX_LATENCY = 0.5;

interface Voice {
  trackId: string;
  source: AudioBufferSourceNode;
  fade: GainNode;
}

type Stretched = { buffer: AudioBuffer } | { pending: Promise<void> } | { failed: true };

export function audioContextClass(): typeof AudioContext {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private gains = new Map<string, GainNode>();
  private tracks: EngineTrack[] = [];
  private voices: Voice[] = [];
  private mapping: ClockMapping | null = null;
  /** The next pass of a loop, scheduled and about to take over. */
  private nextPass: ClockMapping | null = null;
  /** The end of the current pass has been scheduled (stop or next pass). */
  private endScheduled = false;
  private position = 0;
  private wantPlaying = false;
  private rate = 1;
  private rangeStart = 0;
  private rangeEnd: number | null = null;
  private loop = false;
  private duration = 0;
  private stretched = new Map<AudioBuffer, Stretched>();
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly onStateChange = () => {
    if (this.wantPlaying && !this.mapping) this.tryStart();
    this.emit();
  };

  constructor(private readonly options: AudioEngineOptions) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  }

  // ------------------------------------------------------------ public API

  /** The audio context every sound of the sketch plays in (created on first use). */
  get context(): AudioContext {
    if (!this.ctx) {
      const ctx = this.options.createContext?.() ?? new (audioContextClass())({ latencyHint: 'playback' });
      this.ctx = ctx;
      // A limiter on the sum: several loud takes plus the synth must not clip.
      const limiter = ctx.createDynamicsCompressor();
      setParam(limiter.threshold, -2);
      setParam(limiter.knee, 0);
      setParam(limiter.ratio, 20);
      setParam(limiter.attack, 0.002);
      setParam(limiter.release, 0.15);
      const bus = ctx.createGain();
      bus.connect(limiter).connect(ctx.destination);
      this.bus = bus;
      (ctx as EventTarget).addEventListener?.('statechange', this.onStateChange);
    }
    return this.ctx;
  }

  /** Where other sounds (the synth) connect to be mixed with the tracks. */
  get input(): AudioNode {
    void this.context;
    return this.bus!;
  }

  get state(): EngineState {
    return {
      position: this.mapping ? this.heardPosition(true) : this.position,
      playing: this.wantPlaying,
      buffering: this.wantPlaying && (!this.mapping || this.context.state !== 'running'),
    };
  }

  /** The mapping in force while playing. */
  get clock(): ClockMapping | null {
    return this.mapping;
  }

  /**
   * Timeline position being heard right now. Before a start has sounded this
   * lies before the start position (unless `clamped`), which is what
   * recording a take over the sketch needs to place it.
   */
  heardPosition(clamped = false): number {
    const m = this.mapping;
    if (!m || !this.ctx) return this.position;
    let p = m.position + (this.ctx.currentTime - this.latency() - m.time) * m.rate;
    if (clamped) {
      p = Math.max(m.position, p);
      if (m.until !== null) p = Math.min(m.until, p);
    }
    return p;
  }

  /** Wake the audio context. Call inside the tap that leads to sound (WebKit starts audio only in a gesture). */
  unlock() {
    const ctx = this.context;
    if (ctx.state === 'running') return;
    void ctx.resume().catch(() => {});
    try {
      // Older WebKit also wants a sound started in the gesture: one silent sample.
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // not needed where resume() suffices
    }
  }

  /** The tracks, in order. Call again whenever buffers, offsets or audibility change. */
  setTracks(tracks: EngineTrack[]) {
    const previous = new Map(this.tracks.map((t) => [t.id, t]));
    this.tracks = tracks;
    const ctx = this.context;
    for (const track of tracks) {
      let gain = this.gains.get(track.id);
      if (!gain) {
        gain = ctx.createGain();
        gain.gain.value = track.audible ? 1 : 0;
        gain.connect(this.bus!);
        this.gains.set(track.id, gain);
      } else {
        gain.gain.setTargetAtTime(track.audible ? 1 : 0, ctx.currentTime, 0.012);
      }
    }
    for (const [id, gain] of this.gains) {
      if (tracks.some((t) => t.id === id)) continue;
      this.stopVoices((v) => v.trackId === id);
      gain.disconnect();
      this.gains.delete(id);
    }
    for (const [buffer] of this.stretched) {
      if (!tracks.some((t) => t.buffer === buffer)) this.stretched.delete(buffer);
    }
    if (this.mapping) {
      this.updateUntil();
      // A track whose sound or place changed restarts on its own; the others play on.
      for (const track of tracks) {
        const before = previous.get(track.id);
        if (before && before.buffer === track.buffer && before.offset === track.offset) continue;
        this.restartTrack(track);
      }
    } else if (this.wantPlaying) {
      this.tryStart();
    }
    this.emit();
  }

  /** Length of the sketch's timeline (seconds). */
  setDuration(duration: number) {
    this.duration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (this.mapping) this.updateUntil();
  }

  /** Limit playback to [start, end]; `end = null` means to the end of the sketch. */
  setRange(start: number, end: number | null) {
    this.rangeStart = Math.max(0, start);
    this.rangeEnd = end;
    const now = this.mapping ? this.heardPosition(true) : this.position;
    if (now < this.rangeStart - END_EPSILON || (end !== null && now > end + END_EPSILON)) this.seek(this.rangeStart);
    else if (this.mapping) this.updateUntil();
  }

  setLoop(loop: boolean) {
    if (loop === this.loop) return;
    this.loop = loop;
    // A pass already scheduled to stop (or to loop) is replanned.
    if (this.mapping && this.endScheduled) this.restartAll(this.scheduledPosition());
  }

  /** Playback speed (1, 0.75, 0.5…), pitch kept. */
  setRate(rate: number) {
    if (!(rate > 0) || rate === this.rate) return;
    const at = this.mapping ? this.heardPosition(true) : this.position;
    this.rate = rate;
    // Only the copies for the speed in use are kept.
    this.stretched.clear();
    if (this.mapping) {
      this.halt();
      this.position = at;
      this.tryStart();
    }
    this.emit();
  }

  play() {
    this.wantPlaying = true;
    const end = this.effectiveEnd();
    if (this.position < this.rangeStart || (end !== null && this.position >= end - END_EPSILON)) {
      this.position = this.rangeStart;
    }
    this.tryStart();
    this.emit();
  }

  pause() {
    if (this.mapping) this.position = this.clamp(this.heardPosition(true));
    this.wantPlaying = false;
    this.halt();
    this.emit();
  }

  toggle() {
    if (this.wantPlaying) this.pause();
    else this.play();
  }

  /** Move to `time`; playing goes on from there. */
  seek(time: number) {
    const t = this.clamp(time);
    this.position = t;
    const m = this.mapping;
    // A pass that has not started sounding yet already starts there (a tap seeks on press and release).
    const pending = m && Math.abs(m.position - t) < 1e-6 && this.context.currentTime < m.time;
    if (m && !pending) this.restartAll(t);
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.wantPlaying = false;
    this.halt();
    for (const gain of this.gains.values()) gain.disconnect();
    this.gains.clear();
    (this.ctx as EventTarget | null)?.removeEventListener?.('statechange', this.onStateChange);
    // The closed context stays, so a late caller (a note preview) cannot open a new one.
    void this.ctx?.close().catch(() => {});
  }

  // -------------------------------------------------------------- internals

  private latency(): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const l = (ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0);
    return Math.max(0, Math.min(MAX_LATENCY, l));
  }

  private effectiveEnd(): number | null {
    const end = this.duration > 0 ? this.duration : null;
    if (this.rangeEnd === null) return end;
    return end === null ? this.rangeEnd : Math.min(this.rangeEnd, end);
  }

  private clamp(time: number): number {
    const end = this.effectiveEnd();
    let t = Math.max(this.rangeStart, time);
    if (end !== null) t = Math.min(t, end);
    return Math.max(0, t);
  }

  /** Timeline position of what is being scheduled now (ahead of what is heard by the latency). */
  private scheduledPosition(): number {
    const m = this.mapping!;
    return this.clamp(Math.max(m.position, m.position + (this.context.currentTime - m.time) * m.rate));
  }

  /** The buffer a track plays at the current speed, or null (and why, via `pending`). */
  private bufferFor(track: EngineTrack): { buffer: AudioBuffer | null; pending: boolean } {
    if (!track.buffer) return { buffer: null, pending: track.loading };
    if (this.rate === 1) return { buffer: track.buffer, pending: false };
    let entry = this.stretched.get(track.buffer);
    if (!entry) {
      const original = track.buffer;
      const rate = this.rate;
      const stretch = this.options.stretch;
      if (!stretch) {
        entry = { failed: true };
      } else {
        const pending = stretch(this.context, original, rate).then(
          (buffer) => {
            if (this.disposed || this.rate !== rate || this.stretched.get(original) !== entry) return;
            this.stretched.set(original, { buffer });
            this.onBufferReady(original);
          },
          (error) => {
            this.options.log?.(`could not prepare slowed playback: ${error instanceof Error ? error.message : error}`);
            if (this.stretched.get(original) === entry) this.stretched.set(original, { failed: true });
            this.onBufferReady(original);
          },
        );
        entry = { pending };
      }
      this.stretched.set(original, entry);
    }
    if ('buffer' in entry) return { buffer: entry.buffer, pending: false };
    return { buffer: null, pending: 'pending' in entry };
  }

  private onBufferReady(original: AudioBuffer) {
    if (!this.wantPlaying) return;
    if (!this.mapping) this.tryStart();
    else for (const track of this.tracks) if (track.buffer === original) this.restartTrack(track);
    this.emit();
  }

  /** Start if asked to and possible: some track's sound is ready (others join when theirs is) and the clock runs. */
  private tryStart() {
    if (!this.wantPlaying || this.mapping || this.disposed) return;
    const ctx = this.context;
    let ready = 0;
    let pending = 0;
    for (const track of this.tracks) {
      const { buffer, pending: waiting } = this.bufferFor(track);
      if (buffer) ready++;
      else if (waiting) pending++;
    }
    if (ready === 0 && pending > 0) return; // decoding or stretching; called again when done
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      return; // 'statechange' calls again
    }
    this.startPass({ position: this.position, time: ctx.currentTime + LEAD, rate: this.rate, until: this.effectiveEnd() });
    this.startFrames();
  }

  private startPass(mapping: ClockMapping) {
    this.mapping = mapping;
    this.nextPass = null;
    this.endScheduled = false;
    for (const track of this.tracks) this.startVoice(track, mapping);
    this.options.onCue?.(mapping);
  }

  /** One track's source for a pass, timed so the track's time `p - offset` sounds when the timeline is at `p`. */
  private startVoice(track: EngineTrack, mapping: ClockMapping) {
    const { buffer } = this.bufferFor(track);
    const gain = this.gains.get(track.id);
    if (!buffer || !gain) return;
    const ctx = this.context;
    const rate = mapping.rate;
    // The buffer is stretched for `rate`: one second of it is `rate` seconds of the track.
    const length = buffer.duration * rate;
    // Never schedule in the past: start no earlier than just ahead of the clock.
    const at = Math.max(mapping.time, ctx.currentTime + 0.01);
    const local = mapping.position + (at - mapping.time) * rate - track.offset;
    if (local >= length - 1e-3) return;
    if (mapping.until !== null && track.offset >= mapping.until) return;
    const when = local < 0 ? at - local / rate : at;
    const offset = Math.max(0, local) / rate;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const fade = ctx.createGain();
    if (offset > 0) {
      // Starting inside the recording (a seek, a loop): fade in so it does not click.
      fade.gain.setValueAtTime(0, when);
      fade.gain.linearRampToValueAtTime(1, when + FADE);
    }
    source.connect(fade).connect(gain);
    source.start(when, offset);
    const voice: Voice = { trackId: track.id, source, fade };
    source.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      try {
        fade.disconnect();
      } catch {
        // already disconnected
      }
    };
    this.voices.push(voice);
  }

  /** Fade out and stop voices (at `at`, default now). */
  private stopVoices(which: (voice: Voice) => boolean = () => true, at?: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const when = Math.max(at ?? ctx.currentTime, ctx.currentTime);
    const keep: Voice[] = [];
    for (const voice of this.voices) {
      if (!which(voice)) {
        keep.push(voice);
        continue;
      }
      voice.fade.gain.setTargetAtTime(0, when, FADE / 3);
      try {
        voice.source.stop(when + FADE * 4);
      } catch {
        // already stopped
      }
    }
    this.voices = keep;
  }

  private restartTrack(track: EngineTrack) {
    if (!this.mapping) return;
    this.stopVoices((v) => v.trackId === track.id);
    if (this.endScheduled) {
      // The pass's end is already scheduled; keep things simple and replan everything.
      this.restartAll(this.scheduledPosition());
      return;
    }
    this.startVoice(track, this.mapping);
  }

  /** Stop every voice and start a new pass from `position`. */
  private restartAll(position: number) {
    this.stopVoices();
    this.mapping = null;
    this.nextPass = null;
    this.endScheduled = false;
    // Followers stop too (only a loop's next pass is handed over without a break).
    this.options.onCue?.(null);
    this.position = this.clamp(position);
    this.tryStart();
  }

  /** Stop the sound and the frame loop (the position is set by the caller). */
  private halt() {
    const wasPlaying = !!this.mapping;
    this.stopVoices();
    this.mapping = null;
    this.nextPass = null;
    this.endScheduled = false;
    this.stopFrames();
    if (wasPlaying) this.options.onCue?.(null);
  }

  private updateUntil() {
    const m = this.mapping;
    if (!m) return;
    const until = this.effectiveEnd();
    if (until === m.until) return;
    if (this.endScheduled) {
      this.restartAll(this.scheduledPosition());
      return;
    }
    m.until = until;
  }

  private startFrames() {
    this.stopFrames();
    const step = () => {
      this.frame = 0;
      if (!this.mapping && !this.wantPlaying) return;
      this.step();
      if (this.mapping || this.wantPlaying) this.frame = this.requestFrame(step);
    };
    this.frame = this.requestFrame(step);
    const every = this.options.backstopMs ?? 200;
    if (every > 0) this.timer = setInterval(() => this.step(false), every);
  }

  private stopFrames() {
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Per frame: hand over to a scheduled loop pass, schedule the end of the pass, stop at the end. */
  private step(frame = true) {
    const m = this.mapping;
    if (!m) {
      if (frame) this.emit();
      return;
    }
    const ctx = this.context;
    const now = ctx.currentTime;
    if (this.nextPass && now - this.latency() >= this.nextPass.time) {
      this.mapping = this.nextPass;
      this.nextPass = null;
      this.endScheduled = false;
    }
    const current = this.mapping!;
    const end = current.until;
    if (end !== null && !this.endScheduled) {
      const endTime = current.time + (end - current.position) / current.rate;
      if (now >= endTime - AHEAD) {
        this.endScheduled = true;
        const looping = this.loop && end - this.rangeStart >= MIN_LOOP;
        this.stopVoices(() => true, endTime);
        if (looping) {
          // The next pass starts exactly where this one ends.
          const next: ClockMapping = { position: this.rangeStart, time: Math.max(endTime, now + 0.01), rate: current.rate, until: end };
          for (const track of this.tracks) this.startVoice(track, next);
          this.nextPass = next;
          this.options.onCue?.(next);
        }
      }
    }
    if (end !== null && !this.nextPass && this.endScheduled && this.heardPosition() >= end - END_EPSILON) {
      // The end of a pass that does not loop: stop, and go back to the crop start (or stay at the end).
      this.wantPlaying = false;
      this.halt();
      this.position = this.rangeEnd !== null ? this.rangeStart : end;
      this.emit();
      return;
    }
    if (frame) {
      this.emit();
      this.options.onFrame?.(this.heardPosition(true), current.rate);
    }
  }

  private emit() {
    if (!this.disposed) this.options.onState(this.state);
  }
}

function setParam(param: AudioParam | undefined, value: number) {
  if (param) param.value = value;
}
