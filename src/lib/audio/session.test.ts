// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginCaptureSession, preparePlaybackSession, webAudioSessionSummary } from './session';
import { AudioEngine } from '../playback/audioEngine';
import { FakeAudioContext, inGesture } from '../testing/fakeAudioContext';

afterEach(() => vi.unstubAllGlobals());

describe('WebKit audio session policy', () => {
  it('requests music playback even when the audio context is already running', () => {
    const audioSession = { type: 'auto', state: 'active' };
    vi.stubGlobal('navigator', { audioSession });
    const ctx = new FakeAudioContext();
    const engine = new AudioEngine({ onState: () => {}, createContext: () => ctx as unknown as AudioContext });
    inGesture(() => engine.unlock());
    expect(audioSession.type).toBe('playback');
    expect(ctx.state).toBe('running');
    engine.dispose();
  });

  it('releases exclusive playback before capture and blocks playback requests until capture finishes', () => {
    const audioSession = { type: 'playback', state: 'active' };
    vi.stubGlobal('navigator', { audioSession });
    const finish = beginCaptureSession();
    try {
      expect(audioSession.type).toBe('auto');
      preparePlaybackSession(); // count-in, canvas backing audio, or a note preview
      expect(audioSession.type).toBe('auto');
    } finally {
      finish();
    }
    expect(audioSession.type).toBe('auto'); // no unsolicited playback at the end of capture
    preparePlaybackSession();
    expect(audioSession.type).toBe('playback');
  });

  it('keeps automatic selection until all capture holds finish, with idempotent cleanup', () => {
    const audioSession = { type: 'playback' };
    vi.stubGlobal('navigator', { audioSession });
    const first = beginCaptureSession();
    const second = beginCaptureSession();
    try {
      first();
      first();
      preparePlaybackSession();
      expect(audioSession.type).toBe('auto');
    } finally {
      first();
      second();
    }
    preparePlaybackSession();
    expect(audioSession.type).toBe('playback');
  });

  it('supports browsers without the experimental API', () => {
    vi.stubGlobal('navigator', {});
    expect(() => preparePlaybackSession()).not.toThrow();
    const finish = beginCaptureSession();
    finish();
    expect(webAudioSessionSummary()).toBe('API unavailable');
  });

  it('reports rejected session changes without preventing playback', () => {
    vi.stubGlobal('navigator', {
      audioSession: {
        get type() { return 'auto'; },
        set type(_value: string) { throw new Error('not allowed'); },
      },
    });
    const log = vi.fn();
    expect(() => preparePlaybackSession(log)).not.toThrow();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('not allowed'));
  });
});
