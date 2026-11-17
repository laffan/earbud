// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { FakeAudioContext } from '../testing/fakeAudioContext';
import { LiveContext } from './liveContext';

class StoppableContext extends FakeAudioContext {
  /** The system takes the audio away (background, a call, the recorder). */
  interrupt() {
    this.setState('suspended');
  }
}

describe('LiveContext', () => {
  function make() {
    const made: StoppableContext[] = [];
    const onRenew = vi.fn();
    const live = new LiveContext({
      create: () => {
        const ctx = new StoppableContext();
        made.push(ctx);
        return ctx as unknown as AudioContext;
      },
      onRenew,
    });
    return { live, made, onRenew };
  }

  it('keeps a context that runs', () => {
    const { live, made, onRenew } = make();
    live.wake();
    live.wake();
    expect(made).toHaveLength(1);
    expect(onRenew).not.toHaveBeenCalled();
  });

  it('replaces a context the system stopped after it ran, inside the tap', () => {
    const { live, made, onRenew } = make();
    live.wake();
    made[0].interrupt();
    expect(live.needsRenewal).toBe(true);
    const ctx = live.wake();
    expect(made).toHaveLength(2);
    expect(ctx).toBe(made[1]);
    expect(made[0].state).toBe('closed');
    expect(onRenew).toHaveBeenCalledWith(made[1], expect.any(String));
  });

  it('replaces it after the page was hidden', () => {
    const { live, made } = make();
    live.wake();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    expect(live.needsRenewal).toBe(true);
    live.wake();
    expect(made).toHaveLength(2);
    expect(live.needsRenewal).toBe(false);
    live.dispose();
  });
});
