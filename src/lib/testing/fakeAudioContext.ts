/**
 * Minimal Web Audio stand-in for tests: a controllable clock plus node
 * stubs that record which oscillators and buffer sources were started and
 * when.
 */
export interface StartedVoice {
  frequency: number;
  /** Oscillator type when it started. */
  type: string;
  when: number;
  stoppedAt: number | null;
}

/** A buffer source that was started: what it plays, when, and from where in the buffer. */
export interface StartedSource {
  buffer: unknown;
  when: number;
  offset: number;
  /** How long it plays from `offset` (seconds; null = to its end). */
  duration: number | null;
  stoppedAt: number | null;
}

class FakeParam {
  value = 1;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  /** Jumps straight to the target (enough to tell audible from silent). */
  setTargetAtTime(target: number) {
    this.value = target;
  }
  cancelScheduledValues() {}
}

/** An AudioBuffer stand-in of `duration` seconds. */
export function fakeBuffer(duration: number, sampleRate = 48000, channels = 1): AudioBuffer {
  const length = Math.round(duration * sampleRate);
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { duration, length, sampleRate, numberOfChannels: channels, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
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
  baseLatency = 0;
  outputLatency = 0;
  destination = new FakeNode();
  started: StartedVoice[] = [];
  sources: StartedSource[] = [];
  private listeners: (() => void)[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    if (type === 'statechange') this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  protected setState(state: 'running' | 'suspended' | 'closed') {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async resume() {
    this.setState('running');
  }
  async close() {
    this.setState('closed');
  }
  /** Sources still due to sound at `time` (started, not stopped before it). */
  playingAt(time: number): StartedSource[] {
    return this.sources.filter((s) => s.when <= time && (s.stoppedAt === null || s.stoppedAt > time));
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam() });
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(), Q: new FakeParam() });
  }
  createDynamicsCompressor() {
    return Object.assign(new FakeNode(), {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
    });
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return fakeBuffer(length / sampleRate, sampleRate, channels);
  }
  createBufferSource() {
    const ctx = this;
    const record: StartedSource = { buffer: null, when: -1, offset: 0, duration: null, stoppedAt: null };
    return Object.assign(new FakeNode(), {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      start(this: { buffer: unknown }, when = 0, offset = 0, duration?: number) {
        record.buffer = this.buffer;
        record.when = when;
        record.offset = offset;
        record.duration = duration ?? null;
        ctx.sources.push(record);
      },
      stop(when = 0) {
        if (record.stoppedAt === null || when < record.stoppedAt) record.stoppedAt = when;
      },
    });
  }
  createOscillator() {
    const ctx = this;
    const voice: StartedVoice = { frequency: 0, type: 'sine', when: -1, stoppedAt: null };
    const frequency = new FakeParam();
    return Object.assign(new FakeNode(), {
      type: 'sine',
      frequency,
      start(this: { type: string }, when: number) {
        voice.frequency = frequency.value;
        voice.type = this.type;
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

/**
 * Like WebKit (Safari, iOS and macOS web views): a context starts suspended,
 * and `resume()` only takes effect inside a user gesture. Outside one, the
 * promise stays pending (WebKit keeps it until playback is allowed).
 */
export class GestureGatedAudioContext extends FakeAudioContext {
  /** Set while a simulated tap is being handled. */
  static inGesture = false;
  override state: 'running' | 'suspended' | 'closed' = 'suspended';
  override async resume() {
    if (!GestureGatedAudioContext.inGesture) return new Promise<void>(() => {});
    this.setState('running');
  }
}

/** Run `fn` as if inside a tap. */
export function inGesture<T>(fn: () => T): T {
  GestureGatedAudioContext.inGesture = true;
  try {
    return fn();
  } finally {
    GestureGatedAudioContext.inGesture = false;
  }
}
