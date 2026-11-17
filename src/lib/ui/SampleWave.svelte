<script lang="ts">
  /**
   * A sample's waveform as a picture: bars of its peaks (an overview of the
   * sound), optionally with the trimmed-off parts faded and a playhead.
   */
  import { onMount } from 'svelte';
  import { computePeaks } from '../audio/peaks';

  interface Props {
    /** Mono samples (null while loading). */
    samples: Float32Array | null;
    sampleRate: number;
    /** The part that plays (seconds); the rest is faded. */
    from?: number;
    to?: number | null;
    /** Where playback is (seconds of the sound), or null. */
    playhead?: number | null;
    /** Bars per pixel width (spacing). */
    bar?: number;
  }

  let { samples, sampleRate, from = 0, to = null, playhead = null, bar = 3 }: Props = $props();

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let width = $state(0);
  let height = $state(0);
  let theme = $state(0);

  const duration = $derived(samples ? samples.length / sampleRate : 0);
  const peaks = $derived(samples && width > 0 ? computePeaks(samples, Math.max(1, Math.floor(width / bar))) : null);

  function draw() {
    if (!canvas || width <= 0 || height <= 0) return;
    void theme;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    const cs = getComputedStyle(container);
    const ink = cs.getPropertyValue('--wave-ink').trim() || cs.getPropertyValue('--ink').trim() || '#333';
    const faded = cs.getPropertyValue('--rule-strong').trim() || '#bbb';
    const mid = height / 2;
    if (!peaks || duration <= 0) {
      g.fillStyle = faded;
      g.fillRect(0, mid - 0.5, width, 1);
      return;
    }
    const end = to ?? duration;
    for (let i = 0; i < peaks.length; i++) {
      const t = ((i + 0.5) / peaks.length) * duration;
      const h = Math.max(1, peaks[i] * (height - 4));
      g.fillStyle = t >= from && t <= end ? ink : faded;
      g.fillRect(i * bar, mid - h / 2, Math.max(1, bar - 1), h);
    }
    if (playhead !== null && playhead >= 0 && playhead <= duration) {
      g.fillStyle = cs.getPropertyValue('--accent').trim() || 'red';
      g.fillRect(Math.round((playhead / duration) * width) - 1, 0, 2, height);
    }
  }

  $effect(() => {
    void [peaks, from, to, playhead, width, height];
    draw();
  });

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });
    observer.observe(container);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => theme++;
    media.addEventListener('change', onTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', onTheme);
    };
  });
</script>

<div class="wave" bind:this={container} aria-hidden="true">
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  .wave {
    position: relative;
    width: 100%;
    height: 100%;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
