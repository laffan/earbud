<script lang="ts">
  /**
   * Overview waveform of the take (from the analysis audio). Drag or tap to
   * scrub. The shaded band shows what the piano roll is currently showing.
   */
  import { onMount } from 'svelte';
  import { loadPeaks, type Peaks } from '../audio/peaks';
  import { formatClock } from './format';

  interface Props {
    path: string | null;
    duration: number;
    currentTime: number;
    /** Visible window of the piano roll, in seconds. */
    viewStart?: number;
    viewEnd?: number;
    onseek?: (time: number, scrubbing: boolean) => void;
  }

  let { path, duration, currentTime, viewStart = 0, viewEnd = 0, onseek }: Props = $props();

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

    // Piano-roll window.
    if (viewEnd > viewStart && viewEnd - viewStart < total * 0.98) {
      const x0 = (viewStart / total) * width;
      const x1 = (Math.min(viewEnd, total) / total) * width;
      ctx.fillStyle = color('--note-soft');
      ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
    }

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

<div class="waveform" bind:this={container} class:scrubbing>
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
</div>

<style>
  .waveform {
    position: relative;
    width: 100%;
    height: 56px;
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
