// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudioContext, fakeBuffer, GestureGatedAudioContext, inGesture } from '../testing/fakeAudioContext';
import { AudioEngine, type ClockMapping, type EngineState, type EngineTrack } from './audioEngine';

/** A frame loop the test advances by hand, with the audio clock. */
function harness(options: { ctx?: FakeAudioContext; stretch?: AudioEngineStretch; log?: (message: string) => void } = {}) {
  const ctx = options.ctx ?? new FakeAudioContext();
  let frames: (() => void)[] = [];
  const states: EngineState[] = [];
  const cues: (ClockMapping | null)[] = [];
  const engine = new AudioEngine({
    createContext: () => ctx as unknown as AudioContext,
    onState: (s) => states.push(s),
    onCue: (m) => cues.push(m ? { ...m } : null),
    stretch: options.stretch,
    log: options.log,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    backstopMs: 0,
  });
  /** Advance the audio clock by `seconds`, running a frame every 1/60 s. */
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
      ctx.currentTime += 1 / 60;
      const due = frames;
      frames = [];
      for (const cb of due) cb();
    }
  };
  return { ctx, engine, states, cues, run, last: () => states[states.length - 1] };
}
type AudioEngineStretch = (ctx: BaseAudioContext, buffer: AudioBuffer, rate: number) => Promise<AudioBuffer>;

const track = (id: string, buffer: AudioBuffer | null, offset = 0, extra: Partial<EngineTrack> = {}): EngineTrack => ({
  id,
  buffer,
  loading: false,
  offset,
  audible: true,
  ...extra,
});

describe('AudioEngine', () => {
  let a: AudioBuffer;
  let b: AudioBuffer;
  let c: AudioBuffer;
  beforeEach(() => {
    a = fakeBuffer(10);
    b = fakeBuffer(8);
    c = fakeBuffer(6);
  });

  it('reports graph signal separately from context state and detects a stalled clock', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const ctx = Object.assign(new FakeAudioContext(), {
      createAnalyser: () => ({
        fftSize: 2048,
        getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.25),
      }),
    });
    const { engine } = harness({ ctx, log });
    try {
      engine.setTracks([track('a', a)]);
      engine.setDuration(10);
      engine.play();
      // A running context does not establish that the audio clock advances.
      await vi.advanceTimersByTimeAsync(2100);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('context=running, clock advanced=0.00 s'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('sampled graph peak=-12.0 dBFS'));
      expect(log).toHaveBeenCalledTimes(1);
      engine.pause();
      await vi.advanceTimersByTimeAsync(3000);
      expect(log).toHaveBeenCalledTimes(1);
      engine.play();
      engine.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      engine.dispose();
      vi.useRealTimers();
    }
  });

  it('starts every track on one clock, each at its place on the timeline', () => {
    const { ctx, engine } = harness();
    // Track b starts 1.5 s into the sketch; c began 0.25 s before its time 0 (a count-in).
    engine.setTracks([track('a', a), track('b', b, 1.5), track('c', c, -0.25)]);
    engine.setDuration(10);
    engine.seek(1);
    engine.play();
    const [sa, sb, sc] = [a, b, c].map((buf) => ctx.sources.find((s) => s.buffer === buf)!);
    // All scheduled against the same start time; b waits until the timeline reaches 1.5 s.
    expect(sa.offset).toBeCloseTo(1, 6);
    expect(sc.offset).toBeCloseTo(1.25, 6);
    expect(sc.when).toBeCloseTo(sa.when, 9);
    expect(sb.offset).toBe(0);
    expect(sb.when - sa.when).toBeCloseTo(0.5, 6);
  });

  it('plays only the trimmed part of a track, where it lies on the timeline', () => {
    const { ctx, engine, run } = harness();
    // Recording time 0 at 2 s on the timeline; only its seconds 1–4 play (timeline 3–6 s).
    engine.setTracks([track('a', a, 2, { start: 1, end: 4 })]);
    engine.setDuration(12);
    engine.play();
    const first = ctx.sources[0];
    expect(first.offset).toBeCloseTo(1, 6);
    expect(first.duration).toBeCloseTo(3, 6);
    expect(first.when - ctx.currentTime).toBeCloseTo(0.05 + 3, 6);
    // From inside the part: starts at once, for what is left of it.
    engine.seek(4.5);
    const inside = ctx.sources[ctx.sources.length - 1];
    expect(inside.offset).toBeCloseTo(2.5, 6);
    expect(inside.duration).toBeCloseTo(1.5, 6);
    // Past it: nothing plays.
    const count = ctx.sources.length;
    engine.seek(7);
    run(0.1);
    expect(ctx.sources.length).toBe(count);
  });

  it('reports the position being heard, behind the clock by the output latency', () => {
    const { ctx, engine, run, last } = harness();
    ctx.baseLatency = 0.01;
    ctx.outputLatency = 0.04;
    engine.setTracks([track('a', a)]);
    engine.setDuration(10);
    engine.play();
    const start = ctx.sources[0].when;
    run(1);
    const expected = ctx.currentTime - 0.05 - start;
    expect(last().position).toBeCloseTo(expected, 3);
    expect(last().playing).toBe(true);
    // Recording over the sketch: right after play() the start has not sounded yet.
    engine.seek(4);
    expect(engine.heardPosition()).toBeLessThan(4);
    expect(4 - engine.heardPosition()).toBeCloseTo(0.05 + 0.05, 3);
  });

  it('mutes by gain without restarting anything', () => {
    const { ctx, engine, run } = harness();
    engine.setTracks([track('a', a), track('b', b)]);
    engine.setDuration(10);
    engine.play();
    run(0.5);
    const before = ctx.sources.length;
    engine.setTracks([track('a', a), track('b', b, 0, { audible: false })]);
    run(0.5);
    expect(ctx.sources.length).toBe(before);
    expect(ctx.playingAt(ctx.currentTime)).toHaveLength(2);
  });

  it('restarts all tracks together on a seek', () => {
    const { ctx, engine, run } = harness();
    engine.setTracks([track('a', a), track('b', b, 1)]);
    engine.setDuration(10);
    engine.play();
    run(0.5);
    const earlier = ctx.sources.slice();
    engine.seek(5);
    const now = ctx.currentTime;
    const fresh = ctx.sources.slice(earlier.length);
    expect(fresh).toHaveLength(2);
    expect(fresh.find((s) => s.buffer === a)!.offset).toBeCloseTo(5, 6);
    expect(fresh.find((s) => s.buffer === b)!.offset).toBeCloseTo(4, 6);
    // The earlier sources fade out right away (b's, not started yet, never sounds).
    for (const s of earlier) expect(s.stoppedAt).toBeLessThan(now + 0.05);
    expect(fresh.find((s) => s.buffer === a)!.when).toBeGreaterThan(now);
  });

  it('adds a track that finishes decoding while playing, in step', () => {
    const { ctx, engine, run } = harness();
    engine.setTracks([track('a', a), track('b', null, 0, { loading: true })]);
    engine.setDuration(10);
    engine.play();
    run(1);
    engine.setTracks([track('a', a), track('b', b)]);
    const sa = ctx.sources.find((s) => s.buffer === a)!;
    const sb = ctx.sources.find((s) => s.buffer === b)!;
    // b's buffer offset is where a's is at the moment b starts.
    expect(sb.offset).toBeCloseTo(sa.offset + (sb.when - sa.when), 6);
  });

  it('waits for audio when nothing is decoded yet', () => {
    const { ctx, engine, last } = harness();
    engine.setTracks([track('a', null, 0, { loading: true })]);
    engine.setDuration(10);
    engine.play();
    expect(ctx.sources).toHaveLength(0);
    expect(last()).toMatchObject({ playing: true, buffering: true });
    engine.setTracks([track('a', a)]);
    expect(ctx.sources).toHaveLength(1);
    expect(last().buffering).toBe(false);
  });

  it('stops at the crop end and goes back to the crop start', () => {
    const { ctx, engine, run, last, cues } = harness();
    engine.setTracks([track('a', a)]);
    engine.setDuration(10);
    engine.setRange(2, 3);
    engine.play();
    expect(ctx.sources[0].offset).toBeCloseTo(2, 6);
    run(1.5);
    expect(last()).toMatchObject({ playing: false, position: 2 });
    // The sound was stopped exactly at the end, not a frame later.
    const endTime = ctx.sources[0].when + 1;
    expect(ctx.sources[0].stoppedAt! - endTime).toBeLessThan(0.05);
    expect(ctx.sources[0].stoppedAt!).toBeGreaterThanOrEqual(endTime);
    expect(cues[cues.length - 1]).toBeNull();
  });

  it('loops without a gap: the next pass starts where the last one ends', () => {
    const { ctx, engine, run, last, cues } = harness();
    engine.setTracks([track('a', a)]);
    engine.setDuration(10);
    engine.setRange(2, 3);
    engine.setLoop(true);
    engine.play();
    run(2.6);
    const passes = ctx.sources.filter((s) => s.buffer === a);
    expect(passes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < passes.length; i++) {
      expect(passes[i].offset).toBeCloseTo(2, 6);
      // Next pass begins exactly when the previous is stopped.
      expect(passes[i].when).toBeCloseTo(passes[i - 1].when + (i === 1 ? 1 : 1), 6);
      expect(passes[i - 1].stoppedAt! - passes[i].when).toBeLessThan(0.05);
    }
    expect(last().playing).toBe(true);
    expect(last().position).toBeGreaterThanOrEqual(2);
    expect(last().position).toBeLessThanOrEqual(3);
    // Followers were told about each pass ahead of time.
    expect(cues.filter((c) => c && c.position === 2).length).toBeGreaterThanOrEqual(3);
  });

  it('loops back to its own start, so playing from before it runs into the loop', () => {
    const { engine, cues, run } = harness();
    engine.setTracks([track('a', a)]);
    engine.setDuration(10);
    engine.setRange(0, 4);
    engine.setLoop(true, 2);
    engine.seek(1);
    engine.play();
    run(3.4);
    const next = cues.filter((c) => c !== null).at(-1)!;
    expect(next.position).toBeCloseTo(2, 6);
    expect(next.until).toBeCloseTo(4, 6);
  });

  it('plays stretched copies for slowed playback, with the timeline at the slower speed', async () => {
    const stretched = new Map<AudioBuffer, AudioBuffer>();
    const stretch: AudioEngineStretch = async (_ctx, buffer, rate) => {
      const out = fakeBuffer(buffer.duration / rate);
      stretched.set(buffer, out);
      return out;
    };
    const { ctx, engine, run, last } = harness({ stretch });
    engine.setTracks([track('a', a), track('b', b, 2)]);
    engine.setDuration(10);
    engine.setRate(0.5);
    engine.seek(3);
    engine.play();
    expect(last().buffering).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    const sa = ctx.sources.find((s) => s.buffer === stretched.get(a))!;
    const sb = ctx.sources.find((s) => s.buffer === stretched.get(b))!;
    // 3 s into a = 6 s into its half-speed copy; 1 s into b = 2 s into its copy.
    expect(sa.offset).toBeCloseTo(6, 6);
    expect(sb.offset).toBeCloseTo(2, 6);
    run(2);
    expect(last().position).toBeCloseTo(3 + (ctx.currentTime - sa.when) * 0.5, 2);
  });

  it('starts once a tap wakes the audio (WebKit)', () => {
    const ctx = new GestureGatedAudioContext();
    const { engine, last } = harness({ ctx });
    engine.setTracks([track('a', a)]);
    engine.setDuration(10);
    engine.play(); // not in a tap: the context cannot start
    const played = () => ctx.sources.filter((s) => s.buffer === a);
    expect(played()).toHaveLength(0);
    expect(last().buffering).toBe(true);
    inGesture(() => engine.unlock());
    expect(played()).toHaveLength(1);
  });

  it('stays at the end of the sketch when it plays to the end', () => {
    const { engine, run, last } = harness();
    engine.setTracks([track('a', fakeBuffer(1))]);
    engine.setDuration(1);
    engine.play();
    run(1.5);
    expect(last()).toMatchObject({ playing: false, position: 1 });
    // Play again: from the top.
    engine.play();
    expect(last().position).toBe(0);
  });

  it('says when its context may be stuck and should be replaced in the next tap', () => {
    class Stoppable extends FakeAudioContext {
      interrupt() {
        this.setState('suspended');
      }
    }
    const ctx = new Stoppable();
    const { engine } = harness({ ctx });
    expect(engine.needsRenewal).toBe(false);
    engine.setTracks([track('a', fakeBuffer(2))]);
    expect(engine.needsRenewal).toBe(false);
    // The system suspended a context that had been running (the app was in the background).
    ctx.interrupt();
    expect(engine.needsRenewal).toBe(true);
    const fresh = harness();
    fresh.engine.setTracks([]);
    fresh.engine.markStale();
    expect(fresh.engine.needsRenewal).toBe(true);
    fresh.engine.dispose();
    expect(fresh.engine.needsRenewal).toBe(true);
  });
});

