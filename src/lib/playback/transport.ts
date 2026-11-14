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
 *  - A seek is over when the element stops `seeking`, not only on 'seeked':
 *    WebKit drops some seeks without firing either event (see `settleSeek`).
 *  - Several tracks: the clock follows one media element at a time, placed
 *    on the timeline by an offset. `select` says which element covers a
 *    time; the transport switches to it on a seek and when the current one
 *    reaches its end while another continues (see `TrackMixer`).
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
  /** Only its length is used: zero means the media cannot seek (yet). */
  readonly seekable?: { readonly length: number };
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** A media element and where its time 0 lies on the transport's timeline (seconds). */
export interface MediaSlot {
  media: MediaLike;
  offset: number;
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
  /**
   * The current source has finished loading but still cannot seek (it
   * reports no seekable ranges). Called once per source, so the owner can
   * switch to a source that can, e.g. an in-memory copy.
   */
  onUnseekable?: () => void;
  log?: (message: string) => void;
  /**
   * Several tracks: the media that should drive the clock at `time`. Asked
   * on every seek and when the current media reaches its end. Without it
   * the attached media is used throughout.
   */
  select?: (time: number) => MediaSlot | null;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  /** Milliseconds clock (tests); defaults to `performance.now`. */
  now?: () => number;
}

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;
const END_EPSILON = 0.03;
/** A seek that lands within this of its target counts as done (seconds). */
const SEEK_TOLERANCE = 0.1;
/** Stop waiting for a seek after this long, whatever the element says (ms). */
const SEEK_TIMEOUT_MS = 3000;
/** Times a dropped seek is sent again before the UI just follows the media. */
const MAX_SEEK_RETRIES = 3;
/** How long a loaded source may report no seekable ranges before it is called unseekable (ms). */
const UNSEEKABLE_AFTER_MS = 1500;
/** Switch to the next track this long before the current media ends (seconds). */
const HANDOVER_LEAD = 0.06;
/** A media element already this close to the timeline position is not sought when taking over (seconds). */
const HANDOVER_TOLERANCE = 0.25;
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
  'loadeddata',
  'canplaythrough',
  'durationchange',
  'progress',
] as const;

export class MediaTransport {
  private media: MediaLike | null = null;
  /** Timeline position of the attached media's time 0 (seconds). */
  private offset = 0;
  /** Length of the timeline when it is longer than the attached media (several tracks). */
  private timelineDuration: number | null = null;
  private position = 0;
  private playing = false;
  private buffering = false;
  /** What the user asked for (survives reloads and aborted play() calls). */
  private wantPlaying = false;
  /** A seek has been sent to the media and has not completed. */
  private seekInFlight = false;
  /** Target of the seek in flight, and when it was sent (ms). */
  private seekTarget = 0;
  private seekSentAt = 0;
  /** A seek the engine dropped; sent again once the media can seek. */
  private droppedSeek: number | null = null;
  private droppedAt = 0;
  private seekRetries = 0;
  private reportedUnseekable = false;
  /** When a dropped seek was last logged (ms), to keep scrubbing from flooding the log. */
  private dropLoggedAt = -Infinity;
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
  private readonly now: () => number;

  constructor(private readonly options: TransportOptions) {
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.now = options.now ?? (() => performance.now());
  }

  // ------------------------------------------------------------ public API

  get state(): TransportState {
    return { position: this.position, playing: this.playing, buffering: this.buffering };
  }

  /** The media element driving the clock. */
  get current(): MediaLike | null {
    return this.media;
  }

  /** Follow `media`, whose time 0 lies at `offset` on the timeline. */
  attach(media: MediaLike | null, offset = 0) {
    if (this.media === media) {
      if (offset !== this.offset) {
        this.offset = offset;
        if (media && media.readyState >= HAVE_METADATA) this.applySeek(this.position);
      }
      return;
    }
    if (this.media) for (const type of MEDIA_EVENTS) this.media.removeEventListener(type, this.listener);
    this.media = media;
    this.offset = offset;
    this.seekInFlight = false;
    this.queuedSeek = null;
    this.forgetDroppedSeek();
    this.reportedUnseekable = false;
    if (!media) {
      this.setPlaying(false);
      return;
    }
    for (const type of MEDIA_EVENTS) media.addEventListener(type, this.listener);
    if (media.readyState >= HAVE_METADATA) this.applySeek(this.position);
    else this.restoreAt = this.position;
  }

  /**
   * Switch the clock to another media element without stopping: an element
   * that already plays near the position is taken as it is.
   */
  use(slot: MediaSlot | null) {
    if (!slot) {
      this.attach(null);
      return;
    }
    if (slot.media === this.media) {
      this.attach(slot.media, slot.offset);
      return;
    }
    this.switchTo(slot);
  }

  /** Timeline length when several tracks make it longer than one media element (null: the media's own). */
  setDuration(duration: number | null) {
    this.timelineDuration = duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null;
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
    // A new target replaces one the engine dropped earlier.
    this.forgetDroppedSeek();
    this.emit();
    const slot = this.options.select?.(t);
    if (slot && slot.media !== this.media) this.switchTo(slot);
    else this.applySeek(t);
    if (this.playing) this.options.onJump?.(t);
  }

  dispose() {
    this.cancelFrame(this.frame);
    this.frame = 0;
    this.attach(null);
  }

  // -------------------------------------------------------------- internals

  private effectiveEnd(): number | null {
    const mediaEnd = this.media && Number.isFinite(this.media.duration) ? this.offset + this.media.duration : null;
    const duration = this.timelineDuration ?? mediaEnd;
    if (this.rangeEnd === null) return duration;
    return duration === null ? this.rangeEnd : Math.min(this.rangeEnd, duration);
  }

  /** Where the attached media is on the timeline. */
  private timeOf(media: MediaLike): number {
    return media.currentTime + this.offset;
  }

  /** The attached media's own time for timeline position `t`. */
  private mediaTarget(media: MediaLike, t: number): number {
    const local = Math.max(0, t - this.offset);
    return Number.isFinite(media.duration) ? Math.min(local, media.duration) : local;
  }

  /** Move the clock to another element, keeping the position and the play state. */
  private switchTo(slot: MediaSlot) {
    const previous = this.media;
    if (previous) for (const type of MEDIA_EVENTS) previous.removeEventListener(type, this.listener);
    const media = slot.media;
    this.media = media;
    this.offset = slot.offset;
    this.seekInFlight = false;
    this.queuedSeek = null;
    this.restoreAt = null;
    this.forgetDroppedSeek();
    this.reportedUnseekable = false;
    for (const type of MEDIA_EVENTS) media.addEventListener(type, this.listener);
    if (previous) media.playbackRate = previous.playbackRate;
    if (media.readyState >= HAVE_METADATA) {
      const near = Math.abs(this.timeOf(media) - this.position) <= HANDOVER_TOLERANCE;
      if (!(near && !media.paused)) this.applySeek(this.position);
    } else {
      this.restoreAt = this.position;
    }
    if (this.wantPlaying && media.paused) void this.startMedia();
    else this.sync();
  }

  /**
   * At the end of the attached media, hand the clock to the track that goes
   * on from there (if any). Returns whether it switched.
   */
  private handOver(): boolean {
    const media = this.media;
    const select = this.options.select;
    if (!select || !media || !Number.isFinite(media.duration)) return false;
    const end = this.offset + media.duration;
    if (this.position < end - HANDOVER_LEAD && !media.ended) return false;
    const limit = this.effectiveEnd();
    if (limit !== null && end >= limit - END_EPSILON) return false;
    const next = select(end + 0.01);
    if (!next || next.media === media) return false;
    this.options.log?.(`handing playback over to the next track at ${end.toFixed(2)} s`);
    this.switchTo(next);
    return true;
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
      // The previous seek may have been dropped without an event.
      this.settleSeek();
      if (this.seekInFlight) {
        this.queuedSeek = t;
        return;
      }
      this.droppedSeek = null; // superseded by this target
    }
    if (Math.abs(media.currentTime - this.mediaTarget(media, t)) < 0.001) return;
    this.sendSeek(media, t);
  }

  private sendSeek(media: MediaLike, t: number) {
    // Set before assigning: some engines dispatch 'seeking' synchronously.
    this.seekInFlight = true;
    this.seekTarget = t;
    this.seekSentAt = this.now();
    media.currentTime = this.mediaTarget(media, t);
  }

  private forgetDroppedSeek() {
    this.droppedSeek = null;
    this.seekRetries = 0;
  }

  /**
   * End the seek in flight once the element no longer reports `seeking`.
   *
   * Normally that comes with 'seeked'. WebKit, though, drops a seek without
   * firing 'seeking' or 'seeked' when the media has no seekable ranges yet
   * (AVFoundation reports them only once the item is ready to play, which can
   * be after 'loadedmetadata'), and when the engine fails the seek
   * (HTMLMediaElement::seekTask). Waiting for 'seeked' then left the
   * playhead frozen while the audio played on. A seek that ended away from
   * its target is remembered and sent again once the media can seek.
   */
  private settleSeek(sawSeeked = false) {
    const media = this.media;
    if (!media || !this.seekInFlight) return;
    const waited = this.now() - this.seekSentAt;
    if (media.seeking && waited < SEEK_TIMEOUT_MS) return;
    this.seekInFlight = false;
    if (this.queuedSeek !== null) {
      const next = this.queuedSeek;
      this.queuedSeek = null;
      this.applySeek(next);
      return;
    }
    if (media.seeking) {
      this.options.log?.(`seek to ${this.seekTarget.toFixed(2)} s still running after ${Math.round(waited)} ms; following the media`);
      return;
    }
    const target = this.seekTarget;
    if (sawSeeked || Math.abs(this.timeOf(media) - target) <= SEEK_TOLERANCE) {
      this.seekRetries = 0;
      return;
    }
    const ranges = media.seekable?.length;
    if (this.seekRetries >= MAX_SEEK_RETRIES) {
      this.options.log?.(`seek to ${target.toFixed(2)} s dropped again; following the media at ${media.currentTime.toFixed(2)} s`);
      this.forgetDroppedSeek();
      return;
    }
    if (this.now() - this.dropLoggedAt > 2000) {
      this.dropLoggedAt = this.now();
      this.options.log?.(
        `seek to ${target.toFixed(2)} s was dropped by the media engine ` +
          `(at ${media.currentTime.toFixed(2)} s, readyState ${media.readyState}, seekable ranges ${ranges ?? '?'})`,
      );
    }
    this.droppedSeek = target;
    this.droppedAt = this.now();
  }

  /** Send a dropped seek again once the media reports somewhere to seek to. */
  private retryDroppedSeek() {
    const media = this.media;
    const target = this.droppedSeek;
    if (!media || target === null || this.seekInFlight || media.readyState < HAVE_METADATA) return;
    if (media.seekable && media.seekable.length === 0) {
      const loaded = media.readyState >= HAVE_FUTURE_DATA;
      if (loaded && !this.reportedUnseekable && this.now() - this.droppedAt >= UNSEEKABLE_AFTER_MS) {
        this.reportedUnseekable = true;
        this.options.log?.('the media is loaded but reports no seekable ranges');
        this.options.onUnseekable?.();
      }
      return;
    }
    this.droppedSeek = null;
    this.seekRetries++;
    this.applySeek(target);
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
    // Any event is a chance to notice a seek that ended without 'seeked'.
    this.settleSeek(type === 'seeked');
    switch (type) {
      case 'loadstart':
      case 'emptied':
        // A new source (or a reload): remember where we were.
        this.options.log?.(`media ${type} at ${this.position.toFixed(2)} s (wantPlaying=${this.wantPlaying})`);
        // A seek the old source dropped is where the user wanted to be.
        this.restoreAt = this.droppedSeek ?? this.queuedSeek ?? this.position;
        this.seekInFlight = false;
        this.queuedSeek = null;
        this.forgetDroppedSeek();
        this.reportedUnseekable = false;
        if (this.wantPlaying) this.retryPlayOnReady = true;
        break;
      case 'loadedmetadata':
        if (this.restoreAt !== null) {
          const t = this.clampToRange(this.restoreAt);
          this.restoreAt = null;
          if (this.mediaTarget(media, t) > 0.001) this.sendSeek(media, t);
        }
        break;
      case 'error': {
        const err = media.error;
        this.options.log?.(`media error code=${err?.code ?? '?'} ${err?.message ?? ''}`.trim());
        // A failed load never sends 'seeked'; don't stay pinned to a pending seek.
        this.seekInFlight = false;
        this.queuedSeek = null;
        this.forgetDroppedSeek();
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
          this.position = this.timeOf(media);
          if (this.handOver()) return;
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
    if (type === 'ended' && this.wantPlaying && this.handOver()) return;
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
    this.settleSeek();
    this.retryDroppedSeek();
    const playing = !!media && !media.paused && !media.ended;
    if (!playing) this.buffering = false;
    this.setPlaying(playing);
    // While paused, follow the media position only when no seek of ours is
    // pending (a dropped one included: it is sent again once the media can seek).
    const pending = this.seekInFlight || this.queuedSeek !== null || this.restoreAt !== null || this.droppedSeek !== null;
    if (media && !playing && !pending) {
      if (media.readyState >= HAVE_METADATA) this.position = this.timeOf(media);
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
      this.settleSeek();
      this.retryDroppedSeek();
      // While playing, a dropped seek does not hold the playhead: it shows
      // what is playing until the seek is sent again and lands.
      if (!this.seekInFlight && this.queuedSeek === null) {
        this.position = this.timeOf(media);
        if (this.handOver()) {
          // Switching may have started a loop of its own: keep exactly one.
          this.cancelFrame(this.frame);
          this.frame = this.playing ? this.requestFrame(step) : 0;
          return;
        }
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
