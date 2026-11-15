<script lang="ts">
  /**
   * A sketch on the notebook's canvas: its title over its waveform (a
   * recording) or its hits (a rhythm), as wide as it plays. Only the part
   * in view is drawn, so zooming far in costs no more than the screen.
   * A recording played several times in a row shows each repeat after the
   * first lighter, with a mark where it starts again.
   * Passive: the canvas handles every gesture (it finds the tile by
   * `data-tile`, and the repeat grip on its right edge by `data-resize`).
   */
  import type { Sketch } from '../library/types';
  import type { PianoNote } from '../transcription/types';
  import { barSeconds, patternSteps, rhythmHits, stepSeconds, type RhythmPattern } from '../music/rhythm';
  import { canvasNoteRects, RULER_H, TILE_H, type Span } from './canvasGeometry';

  interface Props {
    sketch: Sketch;
    span: Span;
    title: string;
    pps: number;
    /** Where the tile is drawn (world px; may differ from the span while it is dragged). */
    left: number;
    top: number;
    /** Peaks of the whole recording, `peakRate` buckets per second (0–1), or null while loading. */
    peaks: Float32Array | null;
    peakRate: number;
    notes: PianoNote[];
    pattern: RhythmPattern | null;
    /** The visible part of the canvas, in world px (to draw only that). */
    viewLeft: number;
    viewRight: number;
    /** Playing on its own (a single tap); `progress` is the timeline position. */
    soloing: boolean;
    progress: number | null;
    lifted: boolean;
    /** Shown while its length is dragged, e.g. "6 bars". */
    badge?: string | null;
    note?: string | null;
    theme: number;
  }

  let {
    sketch,
    span,
    title,
    pps,
    left,
    top,
    peaks,
    peakRate,
    notes,
    pattern,
    viewLeft,
    viewRight,
    soloing,
    progress,
    lifted,
    badge = null,
    note = null,
    theme,
  }: Props = $props();

  const MIN_W = 28;
  const WAVE_H = 36;
  const width = $derived(Math.max(MIN_W, (span.end - span.start) * pps));
  /** The drawn part of the tile (tile px). */
  const clipFrom = $derived(Math.max(0, Math.floor(viewLeft - left)));
  const clipTo = $derived(Math.min(width, Math.ceil(viewRight - left)));
  /** The title slides along while the start of a long sketch is scrolled out of view. */
  const headShift = $derived(Math.max(0, Math.min(viewLeft - left, width - 140)));
  const meta = $derived(pattern ? `${Math.round(pattern.bpm)} BPM · ${pattern.lengthBars} bar${pattern.lengthBars === 1 ? '' : 's'}` : null);

  let canvas = $state<HTMLCanvasElement | null>(null);

  function color(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  $effect(() => {
    const el = canvas;
    void theme;
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
    if (pattern) drawRhythm(g, pattern, from, to);
    else if (sketch.listenMode === 'notes') drawNotes(g, from, to);
    else drawWave(g, from, to);
  });

  function drawNotes(g: CanvasRenderingContext2D, from: number, to: number) {
    g.fillStyle = color('--note', '#2e4a66');
    for (const rect of canvasNoteRects(notes, span, pps, from, to, WAVE_H)) {
      g.globalAlpha = rect.repeat === 0 ? 1 : 0.5;
      g.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    g.globalAlpha = 1;
    g.fillStyle = color('--ink-3', '#8c8478');
    for (let k = 1; k < span.repeats; k++) {
      const x = Math.round(k * span.cycle * pps) - from;
      if (x >= 0 && x <= to - from) g.fillRect(x, 0, 1, WAVE_H);
    }
  }

  function drawWave(g: CanvasRenderingContext2D, from: number, to: number) {
    const mid = WAVE_H / 2;
    const p = peaks;
    const ink = color('--note', '#2e4a66');
    g.fillStyle = ink;
    if (!p) {
      // Still loading: a quiet line.
      g.globalAlpha = 0.3;
      g.fillRect(0, mid - 0.5, to - from, 1);
      g.globalAlpha = 1;
      return;
    }
    const cycle = Math.max(1e-3, span.cycle);
    for (let x = from; x < to; x++) {
      // Which repeat this column is in, and the recording seconds under it.
      const t = x / pps;
      const k = Math.min(span.repeats - 1, Math.floor(t / cycle));
      const t0 = span.from + (t - k * cycle);
      const t1 = t0 + 1 / pps;
      const b0 = Math.max(0, Math.floor(t0 * peakRate));
      const b1 = Math.min(p.length, Math.max(b0 + 1, Math.ceil(t1 * peakRate)));
      let peak = 0;
      for (let b = b0; b < b1; b++) if (p[b] > peak) peak = p[b];
      const h = Math.max(1, peak * (WAVE_H - 4));
      g.globalAlpha = k === 0 ? 1 : 0.5;
      g.fillRect(x - from, mid - h / 2, 1, h);
    }
    g.globalAlpha = 1;
    // Where each repeat starts again.
    g.fillStyle = color('--ink-3', '#8c8478');
    for (let k = 1; k < span.repeats; k++) {
      const x = Math.round(k * cycle * pps) - from;
      if (x >= 0 && x <= to - from) g.fillRect(x, 0, 1, WAVE_H);
    }
  }

  function drawRhythm(g: CanvasRenderingContext2D, p: RhythmPattern, from: number, to: number) {
    const rows = 3;
    const rowH = (WAVE_H - 6) / rows;
    const step = stepSeconds(p);
    const bar = barSeconds(p);
    const cycle = patternSteps(p) * step;
    const colors = [color('--ink-2', '#5b554c'), color('--accent', '#c8453a'), color('--chord', '#6d5226')];
    // Bars faint, each repeat of the pattern stronger.
    g.fillStyle = color('--rule', '#dcd3c3');
    for (let t = 0; t <= span.to + 1e-6; t += bar) {
      const x = t * pps - from;
      if (x < -1 || x > to - from + 1) continue;
      const repeat = Math.abs(t / cycle - Math.round(t / cycle)) < 1e-6;
      g.globalAlpha = repeat ? 1 : 0.5;
      g.fillRect(Math.round(x), 0, 1, WAVE_H);
    }
    g.globalAlpha = 1;
    const cell = Math.max(1.5, Math.min(step * pps - 1, 10));
    for (const hit of rhythmHits(p)) {
      const x = hit.time * pps - from;
      if (x + cell < 0 || x > to - from) continue;
      g.fillStyle = colors[hit.pad] ?? colors[0];
      g.globalAlpha = 0.35 + 0.65 * hit.level;
      g.fillRect(x, 3 + hit.pad * rowH, cell, rowH - 2);
    }
    g.globalAlpha = 1;
  }
</script>

<div
  class="tile"
  class:rhythm={!!pattern}
  class:soloing
  class:lifted
  data-tile={sketch.id}
  style:transform="translate({left}px, {top + RULER_H}px)"
  style:width="{width}px"
  style:height="{TILE_H}px"
  role="button"
  tabindex="-1"
  aria-label="{title}{pattern ? ', rhythm' : ''}"
>
  <div class="head" style:transform="translateX({headShift}px)">
    <span class="title">{title}</span>
    {#if meta}<span class="meta tabular">{meta}</span>{/if}
    {#if note}<span class="meta">{note}</span>{/if}
  </div>
  {#if clipTo > clipFrom}
    <canvas bind:this={canvas} data-preview={pattern ? 'rhythm' : sketch.listenMode === 'notes' ? 'notes' : 'waveform'}
      aria-label={pattern ? 'Rhythm preview' : sketch.listenMode === 'notes' ? 'Notes preview' : 'Waveform preview'}
      style:left="{clipFrom}px" style:width="{clipTo - clipFrom}px" style:height="{WAVE_H}px"></canvas>
  {/if}
  {#if soloing && progress !== null && progress >= span.start}
    <div class="progress" style:left="{(progress - span.start) * pps}px"></div>
  {/if}
  <div class="grip" class:narrow={width < 72} data-resize={sketch.id} aria-hidden="true"><span></span></div>
  {#if badge}<div class="badge tabular" style:right="{Math.max(22, width - clipTo + 8)}px">{badge}</div>{/if}
</div>

<style>
  .tile {
    position: absolute;
    left: 0;
    top: 0;
    border-radius: 10px;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    box-shadow: var(--shadow);
    overflow: hidden;
    transition:
      box-shadow 120ms ease,
      scale 120ms ease;
    will-change: transform;
  }
  .tile.rhythm {
    background: color-mix(in srgb, var(--paper-raised) 88%, var(--chord));
  }
  .tile.soloing {
    border-color: var(--accent);
    box-shadow:
      0 0 0 2px var(--accent-soft),
      var(--shadow);
  }
  .tile.lifted {
    scale: 1.03;
    z-index: 3;
    box-shadow: 0 10px 28px rgb(40 30 10 / 22%);
    opacity: 0.92;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    height: 24px;
    padding: 5px 8px 0;
    min-width: 0;
    white-space: nowrap;
  }
  .title {
    flex: 0 1 auto;
    font-size: 0.8rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 3em;
  }
  /* Details give way first when the tile is narrow. */
  .meta {
    flex: 0 100 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.7rem;
    color: var(--ink-3);
  }
  canvas {
    position: absolute;
    top: 26px;
    display: block;
    pointer-events: none;
  }
  .progress {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -1px;
    background: var(--accent);
    pointer-events: none;
  }
  .grip {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 18px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
    background: linear-gradient(to right, transparent, color-mix(in srgb, var(--chord) 14%, transparent));
  }
  /* A short sketch keeps most of itself for tapping and holding. */
  .grip.narrow {
    width: 10px;
  }
  .grip span {
    width: 3px;
    height: 22px;
    border-radius: 2px;
    border-left: 1px solid var(--chord);
    border-right: 1px solid var(--chord);
    opacity: 0.7;
    pointer-events: none;
  }
  .badge {
    position: absolute;
    right: 22px;
    top: 4px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 0.72rem;
    background: var(--ink);
    color: var(--paper);
    pointer-events: none;
  }
</style>
