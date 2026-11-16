<script lang="ts">
  /**
   * A new recording on the canvas, made in place: a strip where the sketch
   * will sit, growing with the playhead as the canvas plays, so the other
   * sketches stay in view. It shows the count-in (the beat and its pips), the
   * beat of a rhythm underneath (a dot that flashes), the time, the input
   * level drawn as a waveform as it comes in, and a stop button (during the
   * count-in it cancels). No camera image: a sketch recorded with the camera
   * on still has its video.
   */
  import { onDestroy, untrack } from 'svelte';
  import { app, type RecordingState } from '../state/app.svelte';
  import { RULER_H, TILE_H } from './canvasGeometry';
  import { formatClockTenths } from './format';

  interface Props {
    recording: RecordingState;
    /** Where the strip starts (world px) and its top (canvas px). */
    left: number;
    top: number;
    pps: number;
    /** How far the canvas has played since the recording's start point (seconds; 0 until the downbeat). */
    played: number;
    /** The visible part of the canvas, in world px (only that part of the waveform is drawn). */
    viewLeft: number;
    viewRight: number;
    theme: number;
  }

  let { recording, left, top, pps, played, viewLeft, viewRight, theme }: Props = $props();

  const MIN_W = 168;
  const WAVE_H = 34;
  const counting = $derived(recording.phase === 'recording' && recording.countIn !== null);
  const rolling = $derived(recording.phase === 'recording' && !counting && recording.downbeatMs !== null);
  const width = $derived(Math.max(MIN_W, rolling ? played * pps + 2 : MIN_W));

  let now = $state(performance.now());
  const timer = window.setInterval(() => (now = performance.now()), 200);
  onDestroy(() => window.clearInterval(timer));
  // A double tap on Record must not stop the take it started.
  const canStop = $derived(recording.phase === 'recording' && (counting || now >= recording.armedAt));

  // ------------------------------------------------------------ the level

  /** The input level since the downbeat: when (seconds) and how loud (0–1). */
  let samples: { t: number; v: number }[] = [];
  let version = $state(0);
  $effect(() => {
    // A level event changes the elapsed time even when the level is the same.
    void recording.elapsedMs;
    const db = recording.levelDb;
    if (!rolling) return;
    // Sampled on level events only (not every frame the playhead moves).
    const t = Math.max(0, untrack(() => played));
    const v = Math.max(0, Math.min(1, (db + 60) / 60));
    const last = samples[samples.length - 1];
    if (last && t <= last.t) return;
    samples.push({ t, v });
    version++;
  });
  const clipping = $derived(recording.peakDb > -1);

  // ------------------------------------------------------------ the beat

  let beatOn = $state(false);
  $effect(() => {
    const pulse = rolling ? recording.pulse : null;
    if (!pulse) {
      beatOn = false;
      return;
    }
    let frame = 0;
    const step = () => {
      const since = performance.now() - pulse.firstBeatAt;
      beatOn = since >= -5 && ((since % pulse.periodMs) + pulse.periodMs) % pulse.periodMs < 120;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  });

  // ------------------------------------------------------------ drawing

  /** The drawn part of the strip (strip px). */
  const clipFrom = $derived(Math.max(0, Math.floor(viewLeft - left)));
  const clipTo = $derived(Math.min(width, Math.ceil(viewRight - left)));
  let canvas = $state<HTMLCanvasElement | null>(null);

  function color(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  $effect(() => {
    void version;
    void theme;
    const el = canvas;
    if (!el) return;
    const from = clipFrom;
    const to = clipTo;
    const w = Math.max(0, to - from);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.round(WAVE_H * dpr);
    const g = el.getContext('2d');
    if (!g || w <= 0) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, WAVE_H);
    g.fillStyle = color('--accent', '#c8453a');
    const mid = WAVE_H / 2;
    const bar = Math.max(1, Math.min(4, pps * 0.1 - 0.5));
    for (const s of samples) {
      const x = s.t * pps - from;
      if (x < -bar || x > w) continue;
      const h = Math.max(1, s.v * (WAVE_H - 4));
      g.fillRect(x, mid - h / 2, bar, h);
    }
  });
</script>

<div
  class="strip"
  class:counting
  data-recording-strip
  style:transform="translate({left}px, {top + RULER_H}px)"
  style:width="{width}px"
  style:height="{TILE_H}px"
  role="group"
  aria-label="New recording"
>
  <div class="head" style:transform="translateX({Math.max(0, Math.min(viewLeft - left, width - MIN_W))}px)">
    {#if recording.phase === 'starting'}
      <span class="label">{recording.retry ? 'Restarting…' : 'Starting…'}</span>
    {:else if recording.phase === 'saving'}
      <span class="label">Saving…</span>
    {:else if counting}
      <span class="label">Count-in</span>
    {:else}
      <span class="dot" aria-hidden="true"></span>
      <span class="clock tabular">{formatClockTenths(Math.max(0, played))}</span>
      {#if recording.pulse}<span class="beat-dot" class:on={beatOn} aria-hidden="true"></span>{/if}
      {#if clipping}<span class="clip">loud</span>{/if}
    {/if}
    {#if recording.warning}<span class="warning">{recording.warning}</span>{/if}
  </div>

  {#if counting && recording.countIn}
    <div class="count-in" aria-live="assertive">
      {#key recording.countIn.beat}
        <span class="beat tabular">{recording.countIn.beat > 0 ? recording.countIn.beat : ''}</span>
      {/key}
      <span class="pips" aria-hidden="true">
        {#each Array(recording.countIn.beats) as _, i (i)}
          <span class="pip" class:on={i < recording.countIn.beat}></span>
        {/each}
      </span>
    </div>
  {:else if clipTo > clipFrom}
    <canvas bind:this={canvas} style:left="{clipFrom}px" style:width="{clipTo - clipFrom}px" style:height="{WAVE_H}px" aria-hidden="true"></canvas>
  {/if}

  <button
    class="stop"
    style:left="{Math.max(8, Math.min(width, viewRight - left) - 42)}px"
    onclick={() => app.stopRecording()}
    onpointerdown={(e) => e.stopPropagation()}
    disabled={!canStop}
    aria-label={counting ? 'Cancel recording' : 'Stop and save'}
    title={counting ? 'Cancel' : 'Stop and save'}
  >
    <span class="square" aria-hidden="true"></span>
  </button>
</div>

<style>
  .strip {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 3;
    border-radius: 10px;
    background: color-mix(in srgb, var(--paper-raised) 90%, var(--accent));
    border: 1.5px solid var(--accent);
    box-shadow:
      0 0 0 3px var(--accent-soft),
      var(--shadow);
    overflow: hidden;
    will-change: transform, width;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 4px 8px 0;
    white-space: nowrap;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .label {
    color: var(--ink-2);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.2s steps(2, start) infinite;
  }
  @keyframes blink {
    to {
      visibility: hidden;
    }
  }
  .clock {
    color: var(--ink);
  }
  .beat-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--ink-3);
  }
  .beat-dot.on {
    background: var(--ink);
    border-color: var(--ink);
  }
  .clip {
    padding: 0 6px;
    border-radius: 999px;
    font-size: 0.7rem;
    background: var(--accent);
    color: var(--accent-ink);
  }
  .warning {
    font-weight: 400;
    color: var(--accent);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  canvas {
    position: absolute;
    top: 26px;
    display: block;
    pointer-events: none;
  }
  .count-in {
    position: absolute;
    left: 10px;
    top: 24px;
    bottom: 4px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .beat {
    min-width: 1ch;
    font-size: 1.9rem;
    font-weight: 700;
    line-height: 1;
    color: var(--accent);
    animation: beat 260ms ease-out;
  }
  @keyframes beat {
    from {
      transform: scale(1.35);
      opacity: 0.4;
    }
  }
  .pips {
    display: flex;
    gap: 6px;
  }
  .pip {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--accent);
  }
  .pip.on {
    background: var(--accent);
  }
  .stop {
    position: absolute;
    top: 50%;
    width: 34px;
    height: 34px;
    margin-top: -17px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--paper-raised);
  }
  .stop .square {
    width: 11px;
    height: 11px;
    border-radius: 2px;
    background: var(--accent-ink);
  }
  .counting .stop {
    background: var(--ink-2);
  }
</style>
