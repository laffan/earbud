/**
 * Minimal Web Audio stand-in for tests: a controllable clock plus node
 * stubs that record which oscillators were started and when.
 */
export interface StartedVoice {
  frequency: number;
  when: number;
  stoppedAt: number | null;
}

class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}

class FakeNode {
  connect<T>(node: T): T {
    return node;
  }
  disconnect() {}
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'running';
  sampleRate = 48000;
  destination = new FakeNode();
  started: StartedVoice[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createOscillator() {
    const ctx = this;
    const voice: StartedVoice = { frequency: 0, when: -1, stoppedAt: null };
    const frequency = new FakeParam();
    return Object.assign(new FakeNode(), {
      type: 'sine',
      frequency,
      start(when: number) {
        voice.frequency = frequency.value;
        voice.when = when;
        ctx.started.push(voice);
      },
      stop(when: number) {
        if (voice.stoppedAt === null || when < voice.stoppedAt) voice.stoppedAt = when;
      },
    });
  }
}

/** Number of distinct note attacks at a MIDI pitch (fundamental oscillators). */
export function attacksAt(ctx: FakeAudioContext, pitch: number): StartedVoice[] {
  const f0 = 440 * 2 ** ((pitch - 69) / 12);
  return ctx.started.filter((v) => Math.abs(v.frequency - f0) < 0.01);
}
