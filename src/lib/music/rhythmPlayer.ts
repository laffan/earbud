/**
 * Plays a rhythm pattern in a loop on an audio context: a look-ahead
 * scheduler (every 25 ms, the steps due in the next 120 ms) that reads the
 * pattern on every tick, so edits, tempo and swing changes are heard at once.
 * It remembers when each step was scheduled, to light the step sounding
 * now and to place a pad struck while recording on the step it was meant for.
 */
import { patternSteps, stepSeconds, type RhythmPattern } from './rhythm';

/** What strikes the pads (`DrumKit`, or a stand-in in tests). */
export interface Striker {
  hit(pad: number, when?: number, level?: number): unknown;
}

interface Clock {
  readonly currentTime: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
}

const AHEAD = 0.12;
const LEAD = 0.06;

export class RhythmPlayer {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Time of the next step if it were not swung, and which step it is. */
  private nextBase = 0;
  private nextStep = 0;
  /** Steps scheduled, oldest first (a second's worth kept). */
  private scheduled: { step: number; time: number }[] = [];

  constructor(
    private readonly ctx: Clock,
    private readonly kit: Striker,
    private readonly pattern: () => RhythmPattern | null,
    private readonly every = 25,
  ) {}

  get playing(): boolean {
    return this.timer !== null;
  }

  /** Start looping from `step`. */
  start(step = 0) {
    this.stop();
    this.nextBase = this.ctx.currentTime + LEAD;
    this.nextStep = step;
    this.scheduled = [];
    this.tick();
    if (this.every > 0) this.timer = setInterval(() => this.tick(), this.every);
    else this.timer = 0 as unknown as ReturnType<typeof setInterval>;
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.scheduled = [];
  }

  /** Schedule what is due (called by the timer; tests call it by hand). */
  tick() {
    const p = this.pattern();
    if (!p) return;
    const steps = patternSteps(p);
    const step = stepSeconds(p);
    const now = this.ctx.currentTime;
    while (this.nextBase < now + AHEAD) {
      const index = this.nextStep % steps;
      const time = this.nextBase + (index % 2 === 1 ? (p.swing ?? 0) * step : 0);
      for (let pad = 0; pad < p.pads.length; pad++) {
        const level = p.pads[pad][index] ?? 0;
        if (level > 0) this.kit.hit(pad, time, level);
      }
      this.scheduled.push({ step: index, time });
      this.nextStep = index + 1;
      this.nextBase += step;
    }
    while (this.scheduled.length > 2 && this.scheduled[0].time < now - 1) this.scheduled.shift();
  }

  private latency(): number {
    return Math.max(0, Math.min(0.5, (this.ctx.baseLatency ?? 0) + (this.ctx.outputLatency ?? 0)));
  }

  /** The step being heard now, or -1. */
  currentStep(): number {
    const heard = this.ctx.currentTime - this.latency();
    let current = -1;
    for (const s of this.scheduled) {
      if (s.time <= heard) current = s.step;
      else break;
    }
    return current;
  }

  /** The step whose sound is nearest to what is heard now: where a pad struck now belongs. */
  nearestStep(): number {
    const heard = this.ctx.currentTime - this.latency();
    let best = -1;
    let distance = Infinity;
    for (const s of this.scheduled) {
      const d = Math.abs(s.time - heard);
      if (d < distance) {
        distance = d;
        best = s.step;
      }
    }
    return best;
  }
}
