/**
 * Playback transport: the single source of truth for "where are we and are
 * we playing" across the video, the waveform and the piano roll.
 *
 * Why not just read the <video> element?
 *  - While the user scrubs, the UI must follow the finger, not the media
 *    (which lags behind while it decodes). Seeks are coalesced: one in
 *    flight at a time, always to the latest target.
 *  - "Playing" is re-derived from the element on every relevant event. A
 *    source reload (error fallback, `load()`) stops playback without a
 *    `pause` event; trusting play/pause events alone left the app thinking
 *    it was playing while the video was stopped.
 *  - A pending `play()` that is aborted by a seek or reload is retried
 *    instead of being reported as an error.
 *  - The position survives a source reload, and playback resumes.
 *  - Playback can be limited to a crop range, optionally looping.
 */

/** The parts of HTMLMediaElement the transport uses (fakeable in tests). */
export interface MediaLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly error: { code: number; message?: string } | null;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface TransportState {
  position: number;
  playing: boolean;
  /** Playing, but waiting for data. */
  buffering: boolean;
}

export interface TransportOptions {
  onState: (state: TransportState) => void;
  /** Called every animation frame while playing (for the synth). */
  onFrame?: (position: number, rate: number) => void;
  /** Called after a seek while playing (so followers can resync). */
  onJump?: (position: number) => void;
  onError?: (message: string) => void;
  log?: (message: string) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

const HAVE_METADATA = 1;
const END_EPSILON = 0.03;
const MEDIA_EVENTS = [
  'play',
  'playing',
  'pause',
  'ended',
  'seeked',
  'seeking',
  'waiting',
  'canplay',
  'loadedmetadata',
  'loadstart',
  'emptied',
  'abort',
  'error',
  'stalled',
  'timeupdate',
] as const;

export class MediaTransport {
  private media: MediaLike | null = null;
  private position = 0;
  private playing = false;
  private buffering = false;
  /** What the user asked for (survives reloads and aborted play() calls). */
  private wantPlaying = false;
  /** A seek has been sent to the media and has not completed. */
  private seekInFlight = false;
  /** Latest seek target waiting for the in-flight seek to finish. */
  private queuedSeek: number | null = null;
  /** Position to restore once a (re)loaded source has metadata. */
  private restoreAt: number | null = null;
  private retryPlayOnReady = false;
  private frame = 0;
  private rangeStart = 0;
  private rangeEnd: number | null = null;
  private loop = false;
  private readonly listener = (event: Event) => this.onMediaEvent(event.type);
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (id: number) => void;

  constructor(private readonly options: TransportOptions) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  }

  // ------------------------------------------------------------ public API

  get state(): TransportState {
    return { position: this.position, playing: this.playing, buffering: this.buffering };
  }

  attach(media: MediaLike | null) {
    if (this.media === media) return;
    if (this.media) for (const type of MEDIA_EVENTS) this.media.removeEventListener(type, this.listener);
    this.media = media;
    this.seekInFlight = false;
    this.queuedSeek = null;
    if (!media) {
      this.setPlaying(false);
      return;
    }
    for (const type of MEDIA_EVENTS) media.addEventListener(type, this.listener);
    if (media.readyState >= HAVE_METADATA) this.applySeek(this.position);
    else this.restoreAt = this.position;
  }

  /** Limit playback to [start, end]; `end = null` means the whole take. */
  setRange(start: number, end: number | null) {
    this.rangeStart = Math.max(0, start);
    this.rangeEnd = end;
    if (this.position < this.rangeStart || (end !== null && this.position > end)) {
      this.seek(this.rangeStart);
    }
  }

  setLoop(loop: boolean) {
    this.loop = loop;
  }

  async play() {
    const media = this.media;
    if (!media) return;
    this.wantPlaying = true;
    const end = this.effectiveEnd();
    if (this.position < this.rangeStart || (end !== null && this.position >= end - END_EPSILON)) {
      this.seek(this.rangeStart);
    }
    await this.startMedia();
  }

  pause() {
    this.wantPlaying = false;
    this.retryPlayOnReady = false;
    this.media?.pause();
    this.sync();
  }

  toggle() {
    if (this.wantPlaying && (this.playing || this.buffering || this.media?.paused === false)) this.pause();
    else void this.play();
  }

  /**
   * Move to `time`. The UI position updates immediately; the media follows
   * with at most one seek in flight.
   */
  seek(time: number) {
    const t = this.clampToRange(time);
    this.position = t;
    this.emit();
    this.applySeek(t);
    if (this.playing) this.options.onJump?.(t);
  }

  dispose() {
    this.cancelFrame(this.frame);
    this.frame = 0;
    this.attach(null);
  }

  // -------------------------------------------------------------- internals

  private effectiveEnd(): number | null {
    const duration = this.media && Number.isFinite(this.media.duration) ? this.media.duration : null;
    if (this.rangeEnd === null) return duration;
    return duration === null ? this.rangeEnd : Math.min(this.rangeEnd, duration);
  }

  private clampToRange(time: number): number {
    const end = this.effectiveEnd();
    let t = Math.max(this.rangeStart, time);
    if (end !== null) t = Math.min(t, end);
    return Math.max(0, t);
  }

  private applySeek(t: number) {
    const media = this.media;
    if (!media) return;
    if (media.readyState < HAVE_METADATA) {
      this.restoreAt = t; // applied on loadedmetadata
      return;
    }
    if (this.seekInFlight) {
      this.queuedSeek = t;
      return;
    }
    if (Math.abs(media.currentTime - t) < 0.001) return;
    this.seekInFlight = true;
    media.currentTime = t;
  }

  private async startMedia() {
    const media = this.media;
    if (!media) return;
    try {
      await media.play();
      this.retryPlayOnReady = false;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'AbortError') {
        // Interrupted by a seek or a reload: try again once the media is ready.
        this.options.log?.('play() was interrupted; retrying when the media is ready');
        if (this.wantPlaying) this.retryPlayOnReady = true;
      } else if (name === 'NotAllowedError') {
        this.wantPlaying = false;
        this.options.onError?.('Playback was blocked. Tap play again.');
      } else {
        this.wantPlaying = false;
        const message = error instanceof Error ? error.message : String(error);
        this.options.log?.(`play() failed: ${name} ${message}`);
        this.options.onError?.(`Playback failed: ${message}`);
      }
    } finally {
      this.sync();
    }
  }

  private onMediaEvent(type: string) {
    const media = this.media;
    if (!media) return;
    switch (type) {
      case 'seeked':
        this.seekInFlight = false;
        if (this.queuedSeek !== null) {
          const next = this.queuedSeek;
          this.queuedSeek = null;
          this.applySeek(next);
        }
        break;
      case 'loadstart':
      case 'emptied':
        // A new source (or a reload): remember where we were.
        this.options.log?.(`media ${type} at ${this.position.toFixed(2)} s (wantPlaying=${this.wantPlaying})`);
        this.seekInFlight = false;
        this.queuedSeek = null;
        this.restoreAt = this.position;
        if (this.wantPlaying) this.retryPlayOnReady = true;
        break;
      case 'loadedmetadata':
        if (this.restoreAt !== null) {
          const t = this.clampToRange(this.restoreAt);
          this.restoreAt = null;
          if (t > 0.001) {
            this.seekInFlight = true;
            media.currentTime = t;
          }
        }
        break;
      case 'error': {
        const err = media.error;
        this.options.log?.(`media error code=${err?.code ?? '?'} ${err?.message ?? ''}`.trim());
        // A failed load never sends 'seeked'; don't stay pinned to a pending seek.
        this.seekInFlight = false;
        this.queuedSeek = null;
        break;
      }
      case 'abort':
      case 'stalled':
        this.options.log?.(`media ${type} at ${media.currentTime.toFixed(2)} s`);
        break;
      case 'timeupdate':
        // Backstop for the frame loop (animation frames can be throttled,
        // e.g. in Low Power Mode): follow the media while playing too.
        if (!media.paused && !this.seekInFlight && this.queuedSeek === null) {
          this.position = media.currentTime;
          this.checkRangeEnd(media);
        }
        break;
      case 'waiting':
        this.buffering = true;
        break;
      case 'playing':
        this.buffering = false;
        break;
    }
    if (this.retryPlayOnReady && this.wantPlaying && media.paused && !media.seeking && media.readyState >= 2) {
      if (type === 'canplay' || type === 'seeked' || type === 'loadedmetadata') {
        this.retryPlayOnReady = false;
        void this.startMedia();
      }
    }
    if (type === 'ended' && this.wantPlaying && this.loop) {
      this.seek(this.rangeStart);
      void this.startMedia();
    }
    if (type === 'ended' && !this.loop) this.wantPlaying = false;
    this.sync();
  }

  /** Re-derive playing state from the element and keep the frame loop alive. */
  private sync() {
    const media = this.media;
    const playing = !!media && !media.paused && !media.ended;
    if (!playing) this.buffering = false;
    this.setPlaying(playing);
    // While paused, follow the media position only when no seek of ours is pending.
    if (media && !playing && !this.seekInFlight && this.queuedSeek === null && this.restoreAt === null) {
      if (media.readyState >= HAVE_METADATA) this.position = media.currentTime;
    }
    this.emit();
  }

  private setPlaying(playing: boolean) {
    if (playing === this.playing) return;
    this.playing = playing;
    if (playing) this.startFrames();
    else {
      this.cancelFrame(this.frame);
      this.frame = 0;
    }
  }

  private startFrames() {
    this.cancelFrame(this.frame);
    const step = () => {
      const media = this.media;
      if (!media || !this.playing) {
        this.frame = 0;
        return;
      }
      if (!this.seekInFlight && this.queuedSeek === null) {
        this.position = media.currentTime;
        if (this.checkRangeEnd(media)) return;
        this.emit();
        this.options.onFrame?.(this.position, media.playbackRate);
      }
      this.frame = this.requestFrame(step);
    };
    this.frame = this.requestFrame(step);
  }

  /** At the end of the crop range: loop, or stop and go back to its start. */
  private checkRangeEnd(media: MediaLike): boolean {
    const end = this.effectiveEnd();
    if (this.rangeEnd === null || end === null || this.position < end - END_EPSILON) return false;
    if (this.loop) {
      this.seek(this.rangeStart);
      return false;
    }
    this.wantPlaying = false;
    media.pause();
    this.seek(this.rangeStart);
    this.sync();
    return true;
  }

  private emit() {
    this.options.onState(this.state);
  }
}
