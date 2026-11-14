import { beforeEach, describe, expect, it } from 'vitest';
import { selectTrack, timelineLength, TrackMixer, type MixerTrack } from './mixer';
import type { TransportState } from './transport';

/** A media element whose seeks complete at once and whose clock advances on demand. */
class FakeMedia {
  paused = true;
  seeking = false;
  ended = false;
  readyState = 4;
  muted = false;
  error = null;
  playbackRate = 1;
  seekable = { length: 1 };
  seeks: number[] = [];
  private time = 0;
  private listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(public duration: number) {}

  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.seeks.push(t);
    this.fire('seeking');
    this.fire('seeked');
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type } as Event);
  }
  async play() {
    this.paused = false;
    this.ended = false;
    this.fire('play');
    this.fire('playing');
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }
  /** Playback advancing at its own rate; stops at the end like a real element. */
  advance(seconds: number) {
    if (this.paused) return;
    this.time += seconds * this.playbackRate;
    if (this.time >= this.duration) {
      this.time = this.duration;
      this.paused = true;
      this.ended = true;
      this.fire('pause');
      this.fire('ended');
    }
  }
}

let frames: Map<number, () => void>;
let nextFrame: number;
let clock: number;
let state: TransportState;
let mixer: TrackMixer;

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const cb of pending) cb();
}

/** Advance every playing element by `seconds` and run a frame. */
function run(media: FakeMedia[], seconds: number, step = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += step) {
    clock += step * 1000;
    for (const m of media) m.advance(step);
    flushFrame();
  }
}

const track = (id: string, media: FakeMedia, offset = 0, audible = true): MixerTrack => ({
  id,
  media,
  offset,
  duration: media.duration,
  audible,
});

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  clock = 0;
  mixer = new TrackMixer({
    onState: (s) => (state = s),
    requestFrame: (cb) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    now: () => clock,
  });
});

describe('track selection', () => {
  const a = { media: {} as never, offset: 0, duration: 10 };
  const b = { media: {} as never, offset: 4, duration: 12 };
  const c = { media: {} as never, offset: 30, duration: 5 };

  it('prefers the first track that covers the time', () => {
    expect(selectTrack([a, b], 5)).toBe(a);
    expect(selectTrack([b, a], 5)).toBe(b);
    expect(selectTrack([a, b], 12)).toBe(b);
  });

  it('falls back to the next track to start, then the last to end', () => {
    expect(selectTrack([a, b, c], 20)).toBe(c);
    expect(selectTrack([a, b], 40)).toBe(b);
  });

  it('measures the timeline to the end of the latest track', () => {
    expect(timelineLength([a, b, c])).toBe(35);
  });
});

describe('TrackMixer', () => {
  it('plays a follower in step with the clock, offset included', async () => {
    const one = new FakeMedia(20);
    const two = new FakeMedia(20);
    mixer.setTracks([track('1', one), track('2', two, 2)]);
    mixer.seek(5);
    await mixer.play();
    run([one, two], 1);
    expect(one.paused).toBe(false);
    expect(two.paused).toBe(false);
    expect(two.currentTime).toBeCloseTo(one.currentTime - 2, 1);
    expect(state.position).toBeCloseTo(6, 1);
  });

  it('starts a follower only once the playhead reaches it', async () => {
    const one = new FakeMedia(20);
    const late = new FakeMedia(5);
    mixer.setTracks([track('1', one), track('late', late, 3)]);
    await mixer.play();
    run([one, late], 1);
    expect(late.paused).toBe(true);
    run([one, late], 2.5);
    expect(late.paused).toBe(false);
    expect(late.currentTime).toBeCloseTo(0.5, 1);
    run([one, late], 5);
    expect(late.paused).toBe(true); // past its end
  });

  it('hands the clock to a longer track when the first one ends', async () => {
    const one = new FakeMedia(10);
    const two = new FakeMedia(15);
    mixer.setTracks([track('1', one), track('2', two, 2)]);
    mixer.seek(8);
    await mixer.play();
    run([one, two], 4);
    expect(mixer.transport.current).toBe(two);
    expect(state.playing).toBe(true);
    expect(state.position).toBeCloseTo(12, 1);
    run([one, two], 6);
    expect(state.playing).toBe(false); // the end of the last track
    expect(state.position).toBeCloseTo(17, 1);
  });

  it('switches the clock when seeking to where only another track plays', () => {
    const one = new FakeMedia(10);
    const two = new FakeMedia(15);
    mixer.setTracks([track('1', one), track('2', two, 2)]);
    mixer.seek(14);
    expect(mixer.transport.current).toBe(two);
    expect(two.currentTime).toBeCloseTo(12);
    mixer.seek(1);
    expect(mixer.transport.current).toBe(one);
    expect(one.currentTime).toBeCloseTo(1);
  });

  it('mutes tracks that are not audible, and everything when silent', () => {
    const one = new FakeMedia(10);
    const two = new FakeMedia(10);
    mixer.setTracks([track('1', one, 0, false), track('2', two)]);
    expect(one.muted).toBe(true);
    expect(two.muted).toBe(false);
    mixer.setSilent(true);
    expect(two.muted).toBe(true);
  });

  it('nudges the rate of a follower that drifts and seeks one that is far off', async () => {
    const one = new FakeMedia(30);
    const two = new FakeMedia(30);
    mixer.setTracks([track('1', one), track('2', two)]);
    await mixer.play();
    run([one, two], 0.5);
    // The follower runs slow (as a stalling element would).
    for (let i = 0; i < 20; i++) {
      clock += 50;
      one.advance(0.05);
      two.advance(0.04);
      flushFrame();
    }
    expect(two.playbackRate).toBeGreaterThan(1);
    // A large jump is corrected by seeking.
    two.currentTime = 1;
    const seeks = two.seeks.length;
    run([one, two], 0.5);
    expect(two.seeks.length).toBeGreaterThan(seeks);
    expect(Math.abs(two.currentTime - one.currentTime)).toBeLessThan(0.2);
  });
});
