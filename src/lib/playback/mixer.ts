/**
 * Several tracks of one sketch, played together.
 *
 * One `MediaTransport` stays the clock: it follows the media element of the
 * track that covers the playhead (track order decides when several do) and
 * hands over to the next one when that element ends. Every other track's
 * element follows that clock: it is started, paused and moved with it, and
 * kept in step by nudging its playback rate (small drift) or seeking (large
 * drift, at most once per `SEEK_COOLDOWN_MS`). A sketch with one track
 * behaves exactly like the plain transport.
 *
 * Track times: a track's media time 0 lies at `offset` seconds on the
 * sketch's timeline (negative when its recording began before the sketch's
 * time 0, e.g. during a count-in).
 */
import { MediaTransport, type MediaLike, type MediaSlot, type TransportOptions, type TransportState } from './transport';

export interface MixerTrack {
  id: string;
  media: MediaLike | null;
  /** Timeline position of the media's time 0 (seconds). */
  offset: number;
  /** Length of the take (seconds), used until the media reports its own. */
  duration: number;
  /** Not muted (and soloed, when any track is). */
  audible: boolean;
}

/** Drift between a follower and the clock that is corrected by seeking (seconds). */
const SEEK_DRIFT = 0.3;
/** Drift below this is left alone (media clocks are coarse) (seconds). */
const RATE_DRIFT = 0.03;
/** Largest playback-rate correction (fraction). */
const MAX_NUDGE = 0.04;
const SEEK_COOLDOWN_MS = 800;
/** Smoothing of the drift estimate (per frame). */
const DRIFT_SMOOTHING = 0.15;

interface FollowerState {
  drift: number;
  seekedAt: number;
}

/** Span of a track on the timeline. */
export function trackSpan(track: Pick<MixerTrack, 'media' | 'offset' | 'duration'>): { start: number; end: number } {
  const length =
    track.media && Number.isFinite(track.media.duration) && track.media.duration > 0 ? track.media.duration : track.duration;
  return { start: track.offset, end: track.offset + Math.max(0, length) };
}

/**
 * Which track drives the clock at `time`: the first (in track order) whose
 * span covers it; else the one starting soonest after it; else the one that
 * ended last before it.
 */
export function selectTrack<T extends Pick<MixerTrack, 'media' | 'offset' | 'duration'>>(tracks: T[], time: number): T | null {
  const playable = tracks.filter((t) => t.media);
  const covering = playable.find((t) => {
    const span = trackSpan(t);
    return time >= span.start - 1e-6 && time < span.end;
  });
  if (covering) return covering;
  let next: T | null = null;
  let previous: T | null = null;
  for (const t of playable) {
    const span = trackSpan(t);
    if (span.start > time && (!next || span.start < trackSpan(next).start)) next = t;
    if (span.end <= time && (!previous || span.end > trackSpan(previous).end)) previous = t;
  }
  return next ?? previous;
}

/** Length of the sketch: the end of its latest track (seconds). */
export function timelineLength(tracks: Pick<MixerTrack, 'media' | 'offset' | 'duration'>[]): number {
  return tracks.reduce((end, t) => Math.max(end, trackSpan(t).end), 0);
}

export class TrackMixer {
  readonly transport: MediaTransport;
  private tracks: MixerTrack[] = [];
  private rate = 1;
  private silent = false;
  private followers = new Map<MediaLike, FollowerState>();
  private readonly now: () => number;

  constructor(options: TransportOptions) {
    this.now = options.now ?? (() => performance.now());
    this.transport = new MediaTransport({
      ...options,
      select: (time) => this.slotAt(time),
      onState: (state) => {
        options.onState(state);
        this.follow(false);
      },
      onFrame: (position, rate) => {
        options.onFrame?.(position, rate);
        this.follow(true);
      },
      onJump: (position) => {
        options.onJump?.(position);
        this.follow(false, true);
      },
    });
  }

  get state(): TransportState {
    return this.transport.state;
  }

  /** The tracks, in order. Call again whenever media, offsets or mute/solo change. */
  setTracks(tracks: MixerTrack[]) {
    const before = new Set(this.tracks.map((t) => t.media));
    this.tracks = tracks;
    for (const media of [...this.followers.keys()]) {
      if (!tracks.some((t) => t.media === media)) this.followers.delete(media);
    }
    this.transport.setDuration(tracks.length > 1 ? timelineLength(tracks) : null);
    const slot = this.slotAt(this.transport.state.position);
    const current = this.transport.current;
    if (!slot) this.transport.attach(null);
    else if (!current || !tracks.some((t) => t.media === current)) {
      // First attach, or the clock's track went away.
      if (current && before.has(current)) this.transport.use(slot);
      else this.transport.attach(slot.media, slot.offset);
    } else {
      // Keep the clock where it is; only its offset may have changed.
      const track = tracks.find((t) => t.media === current)!;
      this.transport.attach(current, track.offset);
    }
    this.follow(false, true);
  }

  play() {
    return this.transport.play();
  }
  pause() {
    this.transport.pause();
    this.follow(false);
  }
  toggle() {
    this.transport.toggle();
  }
  seek(time: number) {
    this.transport.seek(time);
  }
  setRange(start: number, end: number | null) {
    this.transport.setRange(start, end);
  }
  setLoop(loop: boolean) {
    this.transport.setLoop(loop);
  }

  /** Playback speed for every track. */
  setRate(rate: number) {
    this.rate = rate;
    for (const t of this.tracks) {
      if (!t.media) continue;
      t.media.playbackRate = rate;
      (t.media as MediaLike & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }

  /** Silence every track (the synthesized notes play instead). */
  setSilent(silent: boolean) {
    this.silent = silent;
    this.follow(false);
  }

  dispose() {
    this.transport.dispose();
    for (const t of this.tracks) t.media?.pause();
    this.tracks = [];
    this.followers.clear();
  }

  private slotAt(time: number): MediaSlot | null {
    const track = selectTrack(this.tracks, time);
    return track?.media ? { media: track.media, offset: track.offset } : null;
  }

  /** Bring every non-clock track in line with the clock. */
  private follow(frame: boolean, jumped = false) {
    const clock = this.transport.current;
    const { position, playing } = this.transport.state;
    const now = this.now();
    for (const track of this.tracks) {
      const media = track.media;
      if (!media) continue;
      setMuted(media, this.silent || !track.audible);
      if (media === clock) continue;
      let state = this.followers.get(media);
      if (!state) {
        state = { drift: 0, seekedAt: -Infinity };
        this.followers.set(media, state);
      }
      const span = trackSpan(track);
      const target = position - track.offset;
      const inside = position >= span.start && position < span.end - 0.02;
      if (playing && inside) {
        if (media.paused) {
          if (Math.abs(media.currentTime - target) > RATE_DRIFT) seekTo(media, target, state, now);
          media.playbackRate = this.rate;
          void media.play().catch(() => {});
          state.drift = 0;
          continue;
        }
        if (media.seeking) continue;
        const drift = media.currentTime - target;
        if (jumped || Math.abs(drift) > SEEK_DRIFT * 3) {
          if (Math.abs(drift) > RATE_DRIFT) seekTo(media, target, state, now);
          continue;
        }
        state.drift += (drift - state.drift) * DRIFT_SMOOTHING;
        if (Math.abs(state.drift) > SEEK_DRIFT && now - state.seekedAt > SEEK_COOLDOWN_MS) {
          seekTo(media, target, state, now);
          media.playbackRate = this.rate;
        } else if (Math.abs(state.drift) > RATE_DRIFT) {
          // Ahead: slow down a little; behind: speed up.
          const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -state.drift * 0.5));
          media.playbackRate = this.rate * (1 + nudge);
        } else if (media.playbackRate !== this.rate) {
          media.playbackRate = this.rate;
        }
      } else {
        if (!media.paused) media.pause();
        if (media.playbackRate !== this.rate) media.playbackRate = this.rate;
        if (!frame && !media.seeking && media.readyState >= 1) {
          // Park it where it will be needed.
          const length = span.end - span.start;
          const parked = Math.max(0, Math.min(length, target));
          if (Math.abs(media.currentTime - parked) > 0.05) seekTo(media, parked, state, now);
        }
      }
    }
  }
}

function seekTo(media: MediaLike, time: number, state: FollowerState, now: number) {
  media.currentTime = Math.max(0, time);
  state.seekedAt = now;
  state.drift = 0;
}

function setMuted(media: MediaLike, muted: boolean) {
  const m = media as MediaLike & { muted?: boolean };
  if (m.muted !== muted) m.muted = muted;
}
