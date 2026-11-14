<script lang="ts">
  /**
   * Overview waveform of a take (from its analysis audio), drawn on the
   * sketch's timeline: a take that starts later is drawn further right.
   * Drag or tap to scrub. Press and hold to open a magnifier (a zoomed-in
   * view of the waveform around the finger) that follows the finger while
   * it moves; it works on the crop handles too. The bracket handles at
   * either end crop playback to a section; what lies outside them is dimmed.
   */
  import { onDestroy, onMount } from 'svelte';
  import { DETAIL_RATE, loadPeaks, type Peaks } from '../audio/peaks';
  import { formatClock, formatClockTenths } from './format';

  interface Props {
    path: string | null;
    /** Length of the sketch's timeline (seconds). */
    duration: number;
    /** Sketch time (seconds). */
    currentTime: number;
    /** Where the take's time 0 lies on the sketch's timeline (seconds). */
    offset?: number;
    /** Playback crop range in seconds (null = start / end of the take). */
    cropStart?: number | null;
    cropEnd?: number | null;
    /** No border or rounded corners of its own (attached under a piano roll). */
    flush?: boolean;
    onseek?: (time: number, scrubbing: boolean) => void;
    /** Crop handles moved; `done` is true when the drag ends. */
    oncropchange?: (start: number, end: number, done: boolean) => void;
  }

  let {
    path,
    duration,
    currentTime,
    offset = 0,
    cropStart = null,
    cropEnd = null,
    flush = false,
    onseek,
    oncropchange,
  }: Props = $props();

  /** Shortest crop allowed (seconds). */
  const MIN_CROP = 0.5;
  /** Hold this long without moving to open the magnifier (ms). */
  const HOLD_MS = 350;
  /** Movement that counts as a drag rather than a hold (px). */
  const HOLD_SLOP = 8;
  const LOUPE_W = 210;
  const LOUPE_H = 78;
  /** How much closer the magnifier is than the overview. */
  const LOUPE_ZOOM = 8;

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let loupeCanvas = $state<HTMLCanvasElement | null>(null);
  let width = $state(0);
  let height = $state(0);
  let peaks = $state.raw<Peaks | null>(null);
  let failed = $state(false);
  let themeVersion = $state(0);
  let scrubbing = $state(false);

  $effect(() => {
    const p = path;
    peaks = null;
    failed = false;
    if (!p) return;
    let cancelled = false;
    loadPeaks(p).then(
      (result) => {
        if (!cancelled) peaks = result;
      },
      () => {
        if (!cancelled) failed = true;
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const total = $derived(Math.max(0.001, duration || (peaks ? peaks.duration + offset : 0)));
  const start = $derived(Math.max(0, Math.min(cropStart ?? 0, total)));
  const end = $derived(Math.max(start, Math.min(cropEnd ?? total, total)));
  const startPct = $derived((start / total) * 100);
  const endPct = $derived((end / total) * 100);
  const cropped = $derived(start > 0.01 || end < total - 0.01);

  // ---------------------------------------------------------------- magnifier

  /** The magnifier: where it points (sketch time) and where the finger is (client px). */
  let loupe = $state<{ time: number; clientX: number } | null>(null);
  let holdTimer = 0;
  let pressX = 0;

  function armHold(clientX: number, timeOfPress: () => number) {
    window.clearTimeout(holdTimer);
    pressX = clientX;
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      loupe = { time: timeOfPress(), clientX };
      navigator.vibrate?.(8);
    }, HOLD_MS);
  }

  /** The finger moved: before the hold fires it is a plain drag; after, the magnifier follows. */
  function moveHold(clientX: number, time: number) {
    if (loupe) loupe = { time, clientX };
    else if (holdTimer && Math.abs(clientX - pressX) > HOLD_SLOP) {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    }
  }

  function endHold() {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
    loupe = null;
  }

  onDestroy(() => window.clearTimeout(holdTimer));

  /** Where the magnifier sits: above the waveform (below it if there is no room), inside the window. */
  const loupeBox = $derived.by(() => {
    if (!loupe || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - LOUPE_W - 8, loupe.clientX - LOUPE_W / 2));
    const above = rect.top - LOUPE_H - 14;
    const top = above >= 8 ? above : rect.bottom + 14;
    return { left, top };
  });

  // ------------------------------------------------------------- crop handles

  let dragging = $state<'start' | 'end' | null>(null);

  function handleDown(which: 'start' | 'end', e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = which;
    armHold(e.clientX, () => (which === 'start' ? start : end));
  }

  function handleMove(e: PointerEvent) {
    if (!dragging) return;
    const t = timeAt(e.clientX);
    let edge: number;
    if (dragging === 'start') {
      edge = Math.min(t, end - MIN_CROP);
      oncropchange?.(edge, end, false);
    } else {
      edge = Math.max(t, start + MIN_CROP);
      oncropchange?.(start, edge, false);
    }
    moveHold(e.clientX, Math.max(0, Math.min(total, edge)));
  }

  function handleUp() {
    endHold();
    if (!dragging) return;
    dragging = null;
    oncropchange?.(start, end, true);
  }

  function handleKey(which: 'start' | 'end', e: KeyboardEvent) {
    const step = e.shiftKey ? 1 : 0.1;
    let s = start;
    let en = end;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      if (which === 'start') s -= step;
      else en -= step;
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      if (which === 'start') s += step;
      else en += step;
    } else if (e.key === 'Home') {
      if (which === 'start') s = 0;
      else en = start + MIN_CROP;
    } else if (e.key === 'End') {
      if (which === 'start') s = end - MIN_CROP;
      else en = total;
    } else return;
    e.preventDefault();
    s = Math.max(0, Math.min(s, en - MIN_CROP));
    en = Math.min(total, Math.max(en, s + MIN_CROP));
    oncropchange?.(s, en, true);
  }

  // ------------------------------------------------------------------ drawing

  let colors: Record<string, string> = {};
  let colorsVersion = -1;
  function color(name: string) {
    if (colorsVersion !== themeVersion) {
      colors = {};
      colorsVersion = themeVersion;
    }
    colors[name] ??= getComputedStyle(container).getPropertyValue(name).trim() || '#888';
    return colors[name];
  }

  function fitCanvas(c: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /** Loudest bucket of `values` (at `rate` buckets per second of take time) over a span of sketch time. */
  function peakOver(values: Float32Array, rate: number, from: number, to: number): number | null {
    const a = Math.floor((from - offset) * rate);
    const b = Math.floor((to - offset) * rate);
    if (b < 0 || a >= values.length) return null;
    let v = 0;
    for (let j = Math.max(0, a); j < Math.min(values.length, Math.max(a + 1, b)); j++) v = Math.max(v, values[j]);
    return v;
  }

  function draw() {
    if (!canvas || width <= 0 || height <= 0) return;
    void themeVersion;
    const ctx = fitCanvas(canvas, width, height);
    if (!ctx) return;
    const mid = height / 2;
    const played = color('--ink');
    const unplayed = color('--rule-strong');
    const accent = color('--accent');
    const playheadX = (Math.min(currentTime, total) / total) * width;

    if (peaks) {
      const bar = 3;
      const bars = Math.max(1, Math.floor(width / bar));
      const rate = peaks.values.length / Math.max(0.001, peaks.duration);
      for (let i = 0; i < bars; i++) {
        const v = peakOver(peaks.values, rate, (i / bars) * total, ((i + 1) / bars) * total);
        if (v === null) continue;
        const h = Math.max(1, v * (height - 6));
        const x = i * bar;
        ctx.fillStyle = x < playheadX ? played : unplayed;
        ctx.fillRect(x, mid - h / 2, bar - 1, h);
      }
    } else {
      ctx.fillStyle = unplayed;
      ctx.fillRect(0, mid - 0.5, width, 1);
    }

    ctx.fillStyle = accent;
    ctx.fillRect(Math.round(playheadX) - 1, 0, 2, height);
  }

  /** The magnifier: about LOUPE_ZOOM times closer than the overview, centered on its time. */
  function drawLoupe() {
    const c = loupeCanvas;
    const l = loupe;
    if (!c || !l || width <= 0) return;
    void themeVersion;
    const ctx = fitCanvas(c, LOUPE_W, LOUPE_H);
    if (!ctx) return;
    const span = Math.max(0.5, Math.min(4, (total * LOUPE_W) / (LOUPE_ZOOM * width)));
    const t0 = l.time - span / 2;
    const tOfX = (x: number) => t0 + (x / LOUPE_W) * span;
    const xOfT = (t: number) => ((t - t0) / span) * LOUPE_W;
    const top = 18;
    const h = LOUPE_H - top - 6;
    const mid = top + h / 2;

    ctx.fillStyle = color('--paper-raised');
    ctx.fillRect(0, 0, LOUPE_W, LOUPE_H);
    if (peaks) {
      const bar = 2;
      for (let x = 0; x < LOUPE_W; x += bar) {
        const v = peakOver(peaks.detail, DETAIL_RATE, tOfX(x), tOfX(x + bar));
        if (v === null) continue;
        const bh = Math.max(1, v * h);
        ctx.fillStyle = tOfX(x) < currentTime ? color('--ink') : color('--rule-strong');
        ctx.fillRect(x, mid - bh / 2, bar - 0.5, bh);
      }
    }
    // Outside the crop, and the timeline's ends.
    ctx.fillStyle = color('--paper');
    ctx.globalAlpha = 0.72;
    const a = xOfT(Math.max(0, start));
    const b = xOfT(Math.min(total, end));
    if (a > 0) ctx.fillRect(0, top, a, h);
    if (b < LOUPE_W) ctx.fillRect(b, top, LOUPE_W - b, h);
    ctx.globalAlpha = 1;
    if (cropped) {
      ctx.fillStyle = color('--chord');
      for (const edge of [a, b]) if (edge >= 0 && edge <= LOUPE_W) ctx.fillRect(Math.round(edge) - 1, top, 2, h);
    }
    // The playhead, if in view, and the point under the finger.
    const ph = xOfT(currentTime);
    if (ph >= 0 && ph <= LOUPE_W && Math.abs(ph - LOUPE_W / 2) > 1) {
      ctx.fillStyle = color('--accent');
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(ph) - 1, top, 2, h);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color('--accent');
    ctx.fillRect(LOUPE_W / 2 - 1, top - 2, 2, h + 4);
    ctx.font = '600 11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = color('--ink');
    ctx.fillText(formatClockTenths(l.time), LOUPE_W / 2, 9);
    ctx.textAlign = 'start';
  }

  $effect(() => {
    draw();
  });
  $effect(() => {
    drawLoupe();
  });

  // ------------------------------------------------------------------ input

  function timeAt(clientX: number) {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((clientX - rect.left) / rect.width) * total));
  }

  function onPointerDown(e: PointerEvent) {
    canvas.setPointerCapture(e.pointerId);
    scrubbing = true;
    const t = timeAt(e.clientX);
    onseek?.(t, true);
    armHold(e.clientX, () => timeAt(e.clientX));
  }
  function onPointerMove(e: PointerEvent) {
    if (!scrubbing) return;
    const t = timeAt(e.clientX);
    onseek?.(t, true);
    moveHold(e.clientX, t);
  }
  function onPointerUp(e: PointerEvent) {
    endHold();
    if (!scrubbing) return;
    scrubbing = false;
    onseek?.(timeAt(e.clientX), false);
  }

  function onKeyDown(e: KeyboardEvent) {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') onseek?.(Math.max(0, currentTime - step), false);
    else if (e.key === 'ArrowRight') onseek?.(Math.min(total, currentTime + step), false);
    else return;
    e.preventDefault();
  }

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });
    observer.observe(container);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => themeVersion++;
    media.addEventListener('change', onTheme);
    // Once the magnifier is open, a vertical wobble must not scroll the page away.
    const onTouchMove = (e: TouchEvent) => {
      if ((loupe || dragging) && e.cancelable) e.preventDefault();
    };
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => {
      observer.disconnect();
      media.removeEventListener('change', onTheme);
      container.removeEventListener('touchmove', onTouchMove);
    };
  });
</script>

<div class="waveform" bind:this={container} class:scrubbing class:cropped class:flush>
  <canvas
    bind:this={canvas}
    tabindex="0"
    role="slider"
    aria-label="Position in the take"
    aria-valuemin="0"
    aria-valuemax={Math.round(total)}
    aria-valuenow={Math.round(currentTime)}
    aria-valuetext={formatClock(currentTime)}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={() => {
      scrubbing = false;
      endHold();
    }}
    onkeydown={onKeyDown}
  ></canvas>
  {#if !path || failed}
    <span class="hint">{failed ? 'Waveform unavailable' : 'Waveform appears once the take is processed'}</span>
  {/if}

  {#if oncropchange}
    <div class="shade" style:left="0" style:width="{startPct}%"></div>
    <div class="shade" style:left="{endPct}%" style:right="0"></div>
    <div class="crop-line" style:left="{startPct}%" style:width="{Math.max(0, endPct - startPct)}%"></div>
    <div
      class="handle start"
      class:active={dragging === 'start'}
      style:left="{startPct}%"
      role="slider"
      tabindex="0"
      aria-label="Playback start"
      aria-valuemin="0"
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(start)}
      aria-valuetext={formatClock(start)}
      onpointerdown={(e) => handleDown('start', e)}
      onpointermove={handleMove}
      onpointerup={handleUp}
      onpointercancel={handleUp}
      onkeydown={(e) => handleKey('start', e)}
    >
      <span class="grip"></span>
    </div>
    <div
      class="handle end"
      class:active={dragging === 'end'}
      style:left="{endPct}%"
      role="slider"
      tabindex="0"
      aria-label="Playback end"
      aria-valuemin="0"
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(end)}
      aria-valuetext={formatClock(end)}
      onpointerdown={(e) => handleDown('end', e)}
      onpointermove={handleMove}
      onpointerup={handleUp}
      onpointercancel={handleUp}
      onkeydown={(e) => handleKey('end', e)}
    >
      <span class="grip"></span>
    </div>
  {/if}
</div>

{#if loupe && loupeBox}
  <div class="loupe" style:left="{loupeBox.left}px" style:top="{loupeBox.top}px" aria-hidden="true">
    <canvas bind:this={loupeCanvas} style:width="{LOUPE_W}px" style:height="{LOUPE_H}px"></canvas>
  </div>
{/if}

<style>
  .waveform {
    position: relative;
    width: 100%;
    height: 64px;
    border-radius: var(--radius-sm);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .waveform.flush {
    border: none;
    border-radius: 0;
    height: 56px;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: pan-y;
    cursor: pointer;
    outline: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  canvas:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  /* Crop: dim what will not play, bracket handles at both ends. */
  .shade {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--paper) 72%, transparent);
    pointer-events: none;
  }
  .crop-line {
    position: absolute;
    top: 0;
    bottom: 0;
    border-top: 2px solid transparent;
    border-bottom: 2px solid transparent;
    pointer-events: none;
  }
  .cropped .crop-line {
    border-color: var(--chord);
  }
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 26px;
    touch-action: none;
    cursor: ew-resize;
    outline: none;
    display: flex;
    align-items: center;
    -webkit-touch-callout: none;
  }
  /* The grab area sits inside the kept section so both stay reachable at the edges. */
  .handle.start {
    margin-left: -6px;
    justify-content: flex-start;
  }
  .handle.end {
    margin-left: -20px;
    justify-content: flex-end;
  }
  .grip {
    width: 10px;
    height: 100%;
    background: var(--chord);
    opacity: 0.9;
    box-shadow: 0 0 0 1px var(--paper-raised);
  }
  .handle.start .grip {
    border-radius: 6px 2px 2px 6px;
    margin-left: 6px;
  }
  .handle.end .grip {
    border-radius: 2px 6px 6px 2px;
    margin-right: 6px;
  }
  .grip {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .grip::after {
    content: '';
    width: 2px;
    height: 40%;
    border-radius: 1px;
    background: var(--paper-raised);
    opacity: 0.85;
  }
  .handle.active .grip,
  .handle:focus-visible .grip {
    background: var(--accent);
  }
  .hint {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-size: 0.8rem;
    color: var(--ink-3);
    pointer-events: none;
  }
  .loupe {
    position: fixed;
    z-index: 40;
    pointer-events: none;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--rule-strong);
    box-shadow: var(--shadow);
    background: var(--paper-raised);
  }
  .loupe canvas {
    position: static;
    display: block;
  }
</style>
