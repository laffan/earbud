import { describe, expect, it } from 'vitest';
import { emptyPattern, withStep, type RhythmPattern } from './rhythm';
import { RhythmPlayer } from './rhythmPlayer';

function setup(pattern: RhythmPattern) {
  const clock = { currentTime: 0, outputLatency: 0 };
  const hits: [number, number, number][] = [];
  let p = pattern;
  const player = new RhythmPlayer(clock, { hit: (pad, when = 0, level = 1) => hits.push([pad, +when.toFixed(4), level]) }, () => p, 0);
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 0.025) {
      clock.currentTime += 0.025;
      player.tick();
    }
  };
  return { clock, hits, player, run, set: (next: RhythmPattern) => (p = next) };
}

describe('RhythmPlayer', () => {
  it('loops the pattern, with swing, at each step’s level', () => {
    // 120 BPM: a 16th is 0.125 s. Kick on 1, hat on the second 16th (swung), snare on 2 at 0.5.
    let p = withStep(withStep(withStep(emptyPattern(120, 1), 0, 0, 1), 2, 1, 0.4), 1, 4, 1);
    p = { ...p, swing: 0.5 };
    const { hits, player, run } = setup(p);
    player.start();
    run(2.1);
    // The second pass starts one bar (2 s) after the first, at the 0.06 s lead.
    expect(hits).toEqual([
      [0, 0.06, 1],
      [2, 0.06 + 0.1875, 0.4],
      [1, 0.56, 1],
      [0, 2.06, 1],
      [2, 2.2475, 0.4],
    ]);
  });

  it('plays edits and tempo changes from the next step', () => {
    const { hits, player, run, set } = setup(withStep(emptyPattern(120, 1), 0, 0, 1));
    player.start();
    run(0.3);
    set(withStep(withStep(emptyPattern(60, 1), 0, 0, 1), 1, 8, 1));
    run(2);
    // At 60 BPM a 16th is 0.25 s: step 8 comes later than it would have at 120.
    const snare = hits.find((h) => h[0] === 1);
    expect(snare).toBeDefined();
    expect(snare![1]).toBeGreaterThan(1.06);
  });

  it('tells the step sounding now and the one nearest to a strike', () => {
    const { clock, player, run } = setup(emptyPattern(120, 1));
    player.start();
    run(0.5);
    // Heard now: 0.5 s, steps sound at 0.06 + 0.125 k: step 3 began at 0.435.
    expect(player.currentStep()).toBe(3);
    clock.currentTime = 0.53; // nearer to step 4 (0.56) than to step 3
    expect(player.nearestStep()).toBe(4);
    player.stop();
    expect(player.currentStep()).toBe(-1);
  });
});
