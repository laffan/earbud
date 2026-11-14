/**
 * Keeps the take's video (muted: its sound plays through the audio engine)
 * showing the frame for the playback position. The picture follows the
 * audio, never the other way round, so a video that stalls, drops a seek or
 * decodes slowly can only delay the picture.
 */

/** The parts of HTMLVideoElement used here (fakeable in tests). */
export interface VideoLike {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly readyState: number;
  readonly seekable?: { readonly length: number };
  playbackRate: number;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

/** Picture this far from the sound is moved (seconds). */
const DRIFT = 0.15;
/** Not more than one corrective seek per this while playing (ms). */
const SEEK_COOLDOWN_MS = 1000;
/** While paused, the picture is moved when this far off (seconds). */
const PARK = 0.04;
/** A loaded video that still reports nothing seekable this long after a seek is reported (ms). */
const UNSEEKABLE_AFTER_MS = 1500;

export class VideoFollower {
  private video: VideoLike | null = null;
  private offset = 0;
  private seekedAt = -Infinity;
  private reported = false;

  constructor(
    private readonly options: {
      /** The video cannot seek (WebKit with some file URLs); the owner may switch it to an in-memory copy. */
      onUnseekable?: () => void;
      now?: () => number;
    } = {},
  ) {}

  /** Follow with `video`, whose time 0 lies at `offset` on the timeline. */
  attach(video: VideoLike | null, offset: number) {
    if (video !== this.video) {
      this.video = video;
      this.seekedAt = -Infinity;
      this.reported = false;
      if (video) video.muted = true;
    }
    this.offset = offset;
  }

  /** Call on every frame and state change. */
  update(position: number, playing: boolean, rate: number) {
    const video = this.video;
    if (!video || video.readyState < 1) return;
    const now = this.options.now?.() ?? performance.now();
    const length = Number.isFinite(video.duration) ? video.duration : Infinity;
    const local = position - this.offset;
    const inside = local >= 0 && local < length - 0.05;
    if (Math.abs(video.playbackRate - rate) > 1e-6) video.playbackRate = rate;
    if (playing && inside) {
      if (video.paused) {
        this.seek(video, local, now);
        void video.play().catch(() => {});
        return;
      }
      if (!video.seeking && Math.abs(video.currentTime - local) > DRIFT && now - this.seekedAt > SEEK_COOLDOWN_MS) {
        this.seek(video, local, now);
      }
    } else {
      if (!video.paused) video.pause();
      const parked = Math.max(0, Math.min(local, length - 0.05));
      if (!video.seeking && Math.abs(video.currentTime - parked) > PARK) this.seek(video, parked, now);
    }
    this.checkSeekable(video, now);
  }

  private seek(video: VideoLike, time: number, now: number) {
    video.currentTime = Math.max(0, time);
    this.seekedAt = now;
  }

  private checkSeekable(video: VideoLike, now: number) {
    if (this.reported || !video.seekable || video.seekable.length > 0) return;
    if (video.readyState >= 3 && now - this.seekedAt >= UNSEEKABLE_AFTER_MS && this.seekedAt > -Infinity) {
      this.reported = true;
      this.options.onUnseekable?.();
    }
  }
}
