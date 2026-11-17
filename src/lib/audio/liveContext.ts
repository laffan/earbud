/**
 * An audio context for a view that plays live sound of its own (the rhythm
 * view, the sample library), renewed when it may be stuck.
 *
 * WebKit (Safari, the iOS and macOS web views) only starts audio inside a
 * gesture, and a context that the system suspended or interrupted (the app
 * went to the background, a call, the native recorder took the audio
 * session) can stay silent after `resume()`. So `wake()`, called inside the
 * tap that leads to sound, makes a new context when the old one has run and
 * stopped, or when the page was hidden since, and tells the owner to set its
 * graph up again (`onRenew`).
 */
import { routeOutput } from './devices';
import { preparePlaybackSession } from './session';

function contextClass(): typeof AudioContext {
  return window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
}

export interface LiveContextOptions {
  latencyHint?: AudioContextLatencyCategory;
  /** A new context replaced the old one: rebuild what plays in it. */
  onRenew?: (ctx: AudioContext, reason: string) => void;
  /** The page was hidden: stop what plays (it will not be heard). */
  onHidden?: () => void;
  log?: (message: string) => void;
  /** Creates the context (tests). */
  create?: () => AudioContext;
}

export class LiveContext {
  private ctx: AudioContext | null = null;
  private ran = false;
  private stale = false;
  private disposed = false;
  private readonly onState = () => {
    if (this.ctx?.state === 'running') this.ran = true;
  };
  private readonly onVisibility = () => {
    if (document.visibilityState !== 'hidden') return;
    this.stale = true;
    this.options.onHidden?.();
  };

  constructor(private readonly options: LiveContextOptions = {}) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** The context (made on first use; not woken). */
  get context(): AudioContext {
    if (!this.ctx) this.ctx = this.make();
    return this.ctx;
  }

  get state(): string {
    return this.ctx ? (this.ctx.state as string) : 'none';
  }

  /** It may be stuck and should be replaced at the next gesture. */
  get needsRenewal(): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const state = ctx.state as string;
    return this.stale || state === 'closed' || state === 'interrupted' || (state === 'suspended' && this.ran);
  }

  markStale() {
    this.stale = true;
  }

  /** In a tap that leads to sound: a fresh context if the old one may be stuck, then start it. */
  wake(): AudioContext {
    preparePlaybackSession(this.options.log);
    if (this.needsRenewal) this.renew(this.stale ? 'the page was hidden or the audio was taken' : `context ${this.state}`);
    const ctx = this.context;
    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      try {
        // Older WebKit also wants a sound started in the gesture: one silent sample.
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        source.connect(ctx.destination);
        source.start(0);
      } catch {
        // not needed where resume() suffices
      }
    }
    return ctx;
  }

  dispose() {
    this.disposed = true;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    const old = this.ctx;
    this.ctx = null;
    if (old) {
      old.removeEventListener?.('statechange', this.onState);
      void old.close().catch(() => {});
    }
  }

  private make(): AudioContext {
    const ctx = this.options.create?.() ?? routeOutput(new (contextClass())({ latencyHint: this.options.latencyHint ?? 'interactive' }));
    this.ran = ctx.state === 'running';
    ctx.addEventListener?.('statechange', this.onState);
    return ctx;
  }

  private renew(reason: string) {
    if (this.disposed) return;
    const old = this.ctx;
    this.options.log?.(`new audio context (${reason}; the last one was ${old?.state ?? 'none'})`);
    if (old) {
      old.removeEventListener?.('statechange', this.onState);
      void old.close().catch(() => {});
    }
    this.stale = false;
    this.ctx = this.make();
    this.options.onRenew?.(this.ctx, reason);
  }
}
