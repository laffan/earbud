import { beforeEach, describe, expect, it } from 'vitest';
import { MediaTransport, type TransportState } from './transport';

/** A scriptable stand-in for <video>: seeks complete only when told to. */
class FakeMedia {
  duration = 10;
  paused = true;
  seeking = false;
  ended = false;
  readyState = 4;
  error: { code: number; message?: string } | null = null;
  playbackRate = 1;
  /** Like TimeRanges: WebKit reports none until the media is ready to play. */
  seekable = { length: 1 };
  seeks: number[] = [];
  /** Make the next play() reject like WebKit does when a load interrupts it. */
  abortNextPlay = false;
  private time = 0;
  /** Position before the seek in progress (WebKit returns to it when it drops the seek). */
  private beforeSeek = 0;
  private listeners = new Map<string, Set<(e: Event) => void>>();

  get currentTime() {
    return this.time;
  }
  set currentTime(t: number) {
    if (!this.seeking) this.beforeSeek = this.time;
    this.time = t;
    this.seeks.push(t);
    this.seeking = true;
    this.fire('seeking');
  }

  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type } as Event);
  }

  async play() {
    if (this.abortNextPlay) {
      this.abortNextPlay = false;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    this.paused = false;
    this.ended = false;
    this.fire('play');
    this.fire('playing');
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }

  finishSeek() {
    this.seeking = false;
    this.fire('seeked');
  }
  /**
   * What WebKit's seek task does when the media has no seekable ranges, or
   * when the engine fails the seek: stop seeking, stay where it was, and
   * fire neither 'seeking' nor 'seeked'.
   */
  dropSeek() {
    this.seeking = false;
    this.time = this.beforeSeek;
  }
  /** Playback advancing (no seek). */
  advance(seconds: number) {
    if (!this.paused && !this.seeking) this.time += seconds;
  }
  /** Source change / reload: stops playback WITHOUT a pause event. */
  reload() {
    this.paused = true;
    this.readyState = 0;
    this.time = 0;
    this.seeking = false;
    this.fire('emptied');
    this.fire('loadstart');
  }
  loaded() {
    this.readyState = 4;
    this.fire('loadedmetadata');
    this.fire('canplay');
  }
}

let media: FakeMedia;
let transport: MediaTransport;
let state: TransportState;
let frames: (() => void)[];
let errors: string[];
let clock: number;
let unseekable: number;

function flushFrame() {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb();
}

beforeEach(() => {
  media = new FakeMedia();
  frames = [];
  errors = [];
  clock = 0;
  unseekable = 0;
  transport = new MediaTransport({
    onState: (s) => (state = s),
    onError: (m) => errors.push(m),
    onUnseekable: () => unseekable++,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
    now: () => clock,
  });
  transport.attach(media);
});

describe('MediaTransport', () => {
  it('coalesces seeks while scrubbing and keeps the UI on the finger', () => {
    for (const t of [1, 2, 3, 4]) transport.seek(t);
    expect(state.position).toBe(4);
    expect(media.seeks).toEqual([1]); // one in flight
    media.finishSeek();
    expect(media.seeks).toEqual([1, 4]); // jumps straight to the latest target
    expect(state.position).toBe(4);
    media.finishSeek();
    expect(media.seeks).toEqual([1, 4]);
    expect(state.position).toBe(4);
  });

  it('moves the playhead when playing after a scrub', async () => {
    transport.seek(5);
    media.finishSeek();
    await transport.play();
    expect(state.playing).toBe(true);
    media.advance(0.5);
    flushFrame();
    expect(state.position).toBeCloseTo(5.5);
    media.advance(0.5);
    flushFrame();
    expect(state.position).toBeCloseTo(6);
  });

  it('does not report playing while a seek is pending, and follows the finger meanwhile', async () => {
    await transport.play();
    media.advance(1);
    flushFrame();
    transport.seek(8); // scrub during playback
    media.advance(0.1); // media keeps playing old position until the seek lands
    flushFrame();
    expect(state.position).toBe(8);
    media.finishSeek();
    media.advance(0.2);
    flushFrame();
    expect(state.position).toBeCloseTo(8.2);
  });

  it('recovers from a source reload during playback (no pause event)', async () => {
    await transport.play();
    media.advance(3);
    flushFrame();
    media.reload();
    expect(state.playing).toBe(false); // not stuck showing "pause"
    expect(state.position).toBeCloseTo(3); // UI keeps its place
    media.loaded();
    expect(media.seeks.at(-1)).toBeCloseTo(3); // restored on the new source
    media.finishSeek();
    media.fire('canplay');
    expect(state.playing).toBe(true); // resumed
    expect(errors).toEqual([]);
  });

  it('retries a play() aborted by a seek instead of reporting it', async () => {
    media.abortNextPlay = true;
    await transport.play();
    expect(errors).toEqual([]);
    expect(state.playing).toBe(false);
    media.fire('canplay');
    await Promise.resolve();
    expect(state.playing).toBe(true);
  });

  it('reports real playback failures', async () => {
    media.play = async () => {
      throw new DOMException('Unsupported source', 'NotSupportedError');
    };
    await transport.play();
    expect(errors[0]).toMatch(/Unsupported source/);
  });

  it('stops at the end of a crop range and returns to its start', async () => {
    transport.setRange(2, 4);
    media.finishSeek(); // setRange moved the playhead into the range
    await transport.play();
    media.advance(2);
    flushFrame();
    expect(state.playing).toBe(false);
    expect(state.position).toBe(2);
  });

  it('loops a crop range', async () => {
    transport.setRange(2, 4);
    transport.setLoop(true);
    media.finishSeek();
    await transport.play();
    media.advance(2);
    flushFrame();
    expect(state.playing).toBe(true);
    expect(state.position).toBe(2);
    expect(media.seeks.at(-1)).toBe(2);
  });

  it('keeps seeks inside the crop range', () => {
    transport.setRange(2, 4);
    transport.seek(9);
    expect(state.position).toBe(4);
    transport.seek(0.5);
    expect(state.position).toBe(2);
    media.finishSeek();
    expect(state.position).toBe(2);
  });

  it('starts from the crop start when play is pressed at the end', async () => {
    transport.setRange(2, 4);
    media.finishSeek();
    transport.seek(4);
    media.finishSeek();
    await transport.play();
    expect(state.position).toBe(2);
  });

  it('follows the media on timeupdate when animation frames are throttled', async () => {
    await transport.play();
    media.advance(1.5);
    media.fire('timeupdate'); // no animation frame ran
    expect(state.position).toBeCloseTo(1.5);
  });

  // WebKit (iOS, macOS and Linux webviews) drops some seeks without any event.
  describe('seeks that never send seeked', () => {
    it('keeps the playhead moving when the media has no seekable ranges yet', async () => {
      media.seekable = { length: 0 };
      transport.seek(3);
      media.dropSeek();
      await transport.play();
      media.advance(0.5);
      flushFrame();
      expect(state.position).toBeCloseTo(0.5); // follows what is actually playing
      media.advance(0.5);
      flushFrame();
      expect(state.position).toBeCloseTo(1);
      media.advance(0.5);
      media.fire('timeupdate');
      expect(state.position).toBeCloseTo(1.5);
    });

    it('seeks again once the media can seek', () => {
      media.seekable = { length: 0 };
      transport.seek(3);
      media.dropSeek();
      media.fire('loadeddata');
      expect(state.position).toBe(3); // paused: keeps the place the user chose
      expect(media.seeks).toEqual([3]);
      media.seekable = { length: 1 };
      media.fire('canplay');
      expect(media.seeks).toEqual([3, 3]);
      media.finishSeek();
      expect(state.position).toBe(3);
    });

    it('retries a seek the engine failed while playing, then follows the media', async () => {
      await transport.play();
      media.advance(1);
      flushFrame();
      transport.seek(6);
      media.dropSeek(); // failed
      flushFrame();
      expect(media.seeks).toEqual([6, 6]); // retried
      media.dropSeek();
      flushFrame();
      media.dropSeek();
      flushFrame();
      media.dropSeek();
      flushFrame();
      const attempts = media.seeks.length;
      media.advance(0.5);
      flushFrame();
      flushFrame();
      expect(media.seeks.length).toBe(attempts); // gave up
      expect(state.playing).toBe(true);
      expect(state.position).toBeCloseTo(1.5); // and shows what is playing
    });

    it('ignores a late seeked from an earlier seek while a newer one is running', async () => {
      transport.seek(2);
      transport.seek(5); // queued behind the first
      media.seeking = false; // the first seek finished, its 'seeked' not yet dispatched
      media.fire('timeupdate');
      expect(media.seeks).toEqual([2, 5]); // the queued seek went out
      media.fire('seeked'); // the first seek's event, late
      expect(state.position).toBe(5);
      media.finishSeek();
      expect(state.position).toBe(5);
    });

    it('reports a source that can never seek', () => {
      media.seekable = { length: 0 };
      transport.seek(3);
      media.dropSeek();
      media.fire('canplaythrough');
      expect(unseekable).toBe(0); // may still become seekable
      clock = 2000;
      media.fire('timeupdate');
      expect(unseekable).toBe(1);
      media.fire('timeupdate');
      expect(unseekable).toBe(1); // once per source
    });

    it('stops waiting for a seek that never ends', async () => {
      transport.seek(4);
      await transport.play(); // fake media plays even while "seeking"
      media.seeking = true;
      flushFrame();
      clock = 5000;
      media.seeking = true;
      flushFrame();
      expect(state.position).toBe(4);
      expect(frames.length).toBe(1); // still running
    });

    it('scrubbing while paused on a source that drops seeks sends the latest target', () => {
      media.seekable = { length: 0 };
      transport.seek(1);
      media.dropSeek();
      transport.seek(2); // next pointer move: the first seek ended silently
      media.dropSeek();
      transport.seek(3);
      expect(media.seeks).toEqual([1, 2, 3]); // nothing piles up behind a dead seek
      media.dropSeek();
      media.seekable = { length: 1 };
      media.fire('canplay');
      expect(media.seeks).toEqual([1, 2, 3, 3]);
      media.finishSeek();
      expect(state.position).toBe(3);
    });

    it('restores a dropped seek target when the source is replaced', () => {
      media.seekable = { length: 0 };
      transport.seek(7);
      media.dropSeek();
      media.fire('loadeddata');
      media.reload();
      media.seekable = { length: 1 };
      media.loaded();
      expect(media.seeks.at(-1)).toBe(7);
    });

    it('counts a seek as landed when seeked arrives, even slightly off target', async () => {
      transport.seek(5);
      await transport.play();
      media.advance(0.5); // still seeking: the fake does not advance
      media.seeking = false;
      (media as unknown as { time: number }).time = 5.3; // landed a little late, playing
      media.fire('seeked');
      expect(media.seeks).toEqual([5]); // not resent
      media.advance(0.2);
      flushFrame();
      expect(state.position).toBeCloseTo(5.5);
    });
  });
});
