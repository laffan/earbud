// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { attacksAt, FakeAudioContext } from '../testing/fakeAudioContext';
import { NoteSynth } from './synth';

beforeEach(() => {
  FakeAudioContext.instances = [];
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
});

const notes = [
  { pitch: 60, startTime: 1.0, endTime: 1.5, velocity: 80 },
  { pitch: 64, startTime: 2.0, endTime: 2.5, velocity: 80 },
  { pitch: 67, startTime: 3.0, endTime: 3.5, velocity: 80 },
];

/** Drive the synth like the sketch view's animation loop (60 fps). */
function run(synth: NoteSynth, ctx: FakeAudioContext, opts: { from: number; seconds: number; stallMs?: number; videoStepMs?: number }) {
  const frame = 1 / 60;
  let media = opts.from;
  for (let elapsed = 0; elapsed < opts.seconds; elapsed += frame) {
    media += frame;
    if (elapsed * 1000 >= (opts.stallMs ?? 0)) ctx.currentTime += frame;
    // Optionally report video time in coarse steps, as some WebKit builds do.
    const step = (opts.videoStepMs ?? 0) / 1000;
    const reported = step > 0 ? Math.floor(media / step) * step : media;
    synth.tick(reported, 1);
  }
}

describe('NoteSynth', () => {
  it('plays each note once during normal playback', async () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    await synth.start(0.5, 1);
    const ctx = FakeAudioContext.instances[0];
    run(synth, ctx, { from: 0.5, seconds: 3.5 });
    expect(attacksAt(ctx, 60)).toHaveLength(1);
    expect(attacksAt(ctx, 64)).toHaveLength(1);
    expect(attacksAt(ctx, 67)).toHaveLength(1);
  });

  it('does not retrigger notes when the audio clock starts late (switching to Notes mid-playback)', async () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    await synth.start(0.9, 1);
    const ctx = FakeAudioContext.instances[0];
    run(synth, ctx, { from: 0.9, seconds: 3, stallMs: 300 });
    expect(attacksAt(ctx, 60).length).toBeLessThanOrEqual(1);
    expect(attacksAt(ctx, 64)).toHaveLength(1);
    expect(attacksAt(ctx, 67)).toHaveLength(1);
  });

  it('does not retrigger notes when the video clock advances in steps', async () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    await synth.start(0.5, 1);
    const ctx = FakeAudioContext.instances[0];
    run(synth, ctx, { from: 0.5, seconds: 3.5, videoStepMs: 250 });
    expect(attacksAt(ctx, 60)).toHaveLength(1);
    expect(attacksAt(ctx, 64)).toHaveLength(1);
    expect(attacksAt(ctx, 67)).toHaveLength(1);
  });

  it('resynchronises after a real seek', async () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    await synth.start(0.5, 1);
    const ctx = FakeAudioContext.instances[0];
    run(synth, ctx, { from: 0.5, seconds: 0.3 });
    // The user jumps to 2.9 s: the G at 3.0 s must play soon after.
    run(synth, ctx, { from: 2.9, seconds: 0.4 });
    const g = attacksAt(ctx, 67);
    expect(g).toHaveLength(1);
    expect(g[0].when - ctx.currentTime).toBeLessThan(0.2);
  });
});
