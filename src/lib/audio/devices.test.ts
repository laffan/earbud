import { describe, expect, it, vi } from 'vitest';
import { routeOutput, setOutputDevice } from './devices';

/** A context that can be sent to an output, as Chromium's. */
function fakeContext() {
  const listeners: (() => void)[] = [];
  const ctx = {
    state: 'running' as AudioContextState,
    sinkId: '',
    setSinkId: vi.fn(async function (this: { sinkId: string }, id: string) {
      ctx.sinkId = id;
    }),
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    close() {
      ctx.state = 'closed';
      for (const fn of listeners) fn();
    },
  };
  return ctx;
}

describe('routing output', () => {
  it('sends new and live contexts to the chosen output, and not closed ones', async () => {
    setOutputDevice('');
    const a = fakeContext();
    routeOutput(a as unknown as AudioContext);
    expect(a.setSinkId).not.toHaveBeenCalled(); // already on the system's output
    setOutputDevice('speakers');
    await Promise.resolve();
    expect(a.sinkId).toBe('speakers');
    const b = fakeContext();
    routeOutput(b as unknown as AudioContext);
    expect(b.sinkId).toBe('speakers');
    b.close();
    setOutputDevice('headphones');
    await Promise.resolve();
    expect(a.sinkId).toBe('headphones');
    expect(b.sinkId).toBe('speakers');
    setOutputDevice('');
  });

  it('leaves a context that cannot choose its output as it is', () => {
    const plain = { state: 'running' } as unknown as AudioContext;
    expect(routeOutput(plain)).toBe(plain);
  });
});
