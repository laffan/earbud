<script lang="ts">
  /**
   * Overview waveform of the take (from the analysis audio). Drag or tap to
   * scrub. The bracket handles at either end crop playback to a section;
   * what lies outside them is dimmed, what lies between is only the waveform.
   */
  import { onMount } from 'svelte';
  import { loadPeaks, type Peaks } from '../audio/peaks';
  import { formatClock } from './format';

  interface Props {
    path: string | null;
    duration: number;
    currentTime: number;
    /** Playback crop range in seconds (null = start / end of the take). */
    cropStart?: number | null;
    cropEnd?: number | null;
    onseek?: (time: number, scrubbing: boolean) => void;
    /** Crop handles moved; `done` is true when the drag ends. */
    oncropchange?: (start: number, end: number, done: boolean) => void;
  }

  let {
    path,
    duration,
    currentTime,
    cropStart = null,
    cropEnd = null,
    onseek,
    oncropchange,
  }: Props = $props();

  /** Shortest crop allowed (seconds). */
  const MIN_CROP = 0.5;

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
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

  const total = $derived(Math.max(0.001, duration || peaks?.duration || 0));
  const start = $derived(Math.max(0, Math.min(cropStart ?? 0, total)));
  const end = $derived(Math.max(start, Math.min(cropEnd ?? total, total)));
  const startPct = $derived((start / total) * 100);
  const endPct = $derived((end / total) * 100);
  const cropped = $derived(start > 0.01 || end < total - 0.01);

  // ------------------------------------------------------------- crop handles

  let dragging = $state<'start' | 'end' | null>(null);

  function handleDown(which: 'start' | 'end', e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = which;
  }

  function handleMove(e: PointerEvent) {
    if (!dragging) return;
    const t = timeAt(e.clientX);
    if (dragging === 'start') oncropchange?.(Math.min(t, end - MIN_CROP), end, false);
    else oncropchange?.(start, Math.max(t, start + MIN_CROP), false);
  }

  function handleUp() {
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

  function draw() {
    if (!canvas || width <= 0 || height <= 0) return;
    void themeVersion;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const mid = height / 2;
    const played = color('--ink');
    const unplayed = color('--rule-strong');
    const accent = color('--accent');
    const playheadX = (Math.min(currentTime, total) / total) * width;

    if (peaks) {
      const bar = 3;
      const bars = Math.max(1, Math.floor(width / bar));
      const values = peaks.values;
      // Map the bars onto the audio's own duration (may differ slightly from the video).
      const audioFraction = Math.min(1, peaks.duration / total);
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i / bars / audioFraction) * values.length);
        const to = Math.floor(((i + 1) / bars / audioFraction) * values.length);
        if (from >= values.length) break;
        let v = 0;
        for (let j = from; j < Math.min(values.length, Math.max(from + 1, to)); j++) v = Math.max(v, values[j]);
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

  $effect(() => {
    draw();
  });

  function timeAt(clientX: number) {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((clientX - rect.left) / rect.width) * total));
  }

  function onPointerDown(e: PointerEvent) {
    canvas.setPointerCapture(e.pointerId);
    scrubbing = true;
    onseek?.(timeAt(e.clientX), true);
  }
  function onPointerMove(e: PointerEvent) {
    if (scrubbing) onseek?.(timeAt(e.clientX), true);
  }
  function onPointerUp(e: PointerEvent) {
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
    return () => {
      observer.disconnect();
      media.removeEventListener('change', onTheme);
    };
  });
</script>

<div class="waveform" bind:this={container} class:scrubbing class:cropped>
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
    onpointercancel={() => (scrubbing = false)}
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
</style>
