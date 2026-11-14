// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { attacksAt, FakeAudioContext, GestureGatedAudioContext, inGesture } from '../testing/fakeAudioContext';
import { NoteSynth, type SynthClock } from './synth';

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
function run(synth: NoteSynth, ctx: FakeAudioContext, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    ctx.currentTime += 1 / 60;
    synth.pump();
  }
}

const clock = (position: number, time: number, until: number | null = null, rate = 1): SynthClock => ({
  position,
  time,
  rate,
  until,
});

describe('NoteSynth', () => {
  it('plays each note once, exactly where the clock puts it', () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    synth.unlock();
    const ctx = FakeAudioContext.instances[0];
    synth.cue(clock(0.5, 0.05));
    run(synth, ctx, 3.5);
    for (const [pitch, start] of [
      [60, 1],
      [64, 2],
      [67, 3],
    ]) {
      const attacks = attacksAt(ctx, pitch);
      expect(attacks).toHaveLength(1);
      expect(attacks[0].when).toBeCloseTo(0.05 + (start - 0.5), 6);
    }
  });

  it('follows slowed playback', () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    synth.unlock();
    const ctx = FakeAudioContext.instances[0];
    synth.cue(clock(0.5, 0.05, null, 0.5));
    run(synth, ctx, 6);
    // At half speed, the note 1.5 s of timeline ahead sounds 3 s later.
    expect(attacksAt(ctx, 64)[0].when).toBeCloseTo(0.05 + 3, 6);
  });

  it('starts from the current position when notes are switched on mid-playback', () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    synth.unlock();
    const ctx = FakeAudioContext.instances[0];
    ctx.currentTime = 2.2;
    // The pass began at 0.5 s at audio time 0.05: it is now at 2.65 s.
    synth.cue(clock(0.5, 0.05));
    run(synth, ctx, 1);
    expect(attacksAt(ctx, 60)).toHaveLength(0);
    expect(attacksAt(ctx, 64)).toHaveLength(0);
    expect(attacksAt(ctx, 67)).toHaveLength(1);
  });

  it('plays a pass out before the next one of a loop takes over', () => {
    const synth = new NoteSynth();
    synth.setNotes(notes);
    synth.unlock();
    const ctx = FakeAudioContext.instances[0];
    // Loop over 0.8–2.2 s: the pass starts at audio time 0.05.
    synth.cue(clock(0.8, 0.05, 2.2));
    run(synth, ctx, 1.1);
    // The next pass is announced 0.3 s before the end (at audio time 1.45).
    synth.cue(clock(0.8, 1.45, 2.2));
    run(synth, ctx, 1.4);
    const e = attacksAt(ctx, 64);
    // E (2.0 s) played in the first pass before the switch, and again in the second.
    expect(e.map((v) => +v.when.toFixed(3))).toEqual([1.25, 2.65]);
    expect(attacksAt(ctx, 60)).toHaveLength(2);
    // G (3.0 s) lies past the loop end and never plays.
    expect(attacksAt(ctx, 67)).toHaveLength(0);
  });

  it('limits how many voices sound at once', () => {
    const synth = new NoteSynth();
    const cluster = Array.from({ length: 80 }, (_, i) => ({ pitch: 30 + i, startTime: 1, endTime: 3, velocity: 80 }));
    synth.setNotes(cluster);
    synth.unlock();
    const ctx = FakeAudioContext.instances[0];
    synth.cue(clock(0.5, 0.05));
    run(synth, ctx, 1.5);
    // Each voice has one triangle oscillator (its fundamental).
    const fundamentals = ctx.started.filter((v) => v.type === 'triangle');
    expect(fundamentals).toHaveLength(80);
    const stillOn = fundamentals.filter((v) => v.stoppedAt === null || v.stoppedAt > 1.2);
    expect(stillOn.length).toBeLessThanOrEqual(48);
  });

  it('plays into a shared context and does not close it', async () => {
    const shared = new FakeAudioContext();
    const destination = shared.createGain();
    const synth = new NoteSynth({ context: () => shared as unknown as AudioContext, destination: () => destination as unknown as AudioNode });
    synth.setNotes(notes);
    synth.cue(clock(0.5, 0.05));
    run(synth, shared, 1);
    expect(attacksAt(shared, 60)).toHaveLength(1);
    synth.dispose();
    expect(shared.state).toBe('running');
  });
});

describe('NoteSynth in WebKit (audio starts only in a tap)', () => {
  beforeEach(() => {
    (window as unknown as { AudioContext: unknown }).AudioContext = GestureGatedAudioContext;
  });

  it('wakes its context when unlocked in a tap', () => {
    const synth = new NoteSynth();
    inGesture(() => synth.unlock());
    expect(FakeAudioContext.instances[0].state).toBe('running');
  });

  it('stays suspended when unlocked outside a tap', () => {
    const synth = new NoteSynth();
    synth.unlock();
    expect(FakeAudioContext.instances[0].state).toBe('suspended');
  });
});
