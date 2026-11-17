<script lang="ts">
  /**
   * Overview waveform of a take (from its analysis audio), drawn on the
   * sketch's timeline: a take that starts later is drawn further right.
   * Drag or tap to scrub. Press and hold to open a magnifier (a zoomed-in
   * view of the waveform around the finger) that follows the finger while
   * it moves; it works on the crop handles too. The bracket handles at
   * either end crop playback to a section; what lies outside them is dimmed.
   *
   * With `onaddsample`: hold Ctrl and drag across the waveform, or press and
   * hold it for 2 seconds without moving (then drag, or let go), to select a
   * passage. A tooltip over it offers *Add to library*; its edges can be
   * dragged, and a tap elsewhere (or Esc) lets it go.
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
    /** A passage selected for the sample library (sketch time): add it. */
    onaddsample?: (start: number, end: number) => void | Promise<void>;
    /** Hear the selected passage. */
    onpreviewsample?: (start: number, end: number) => void;
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
    onaddsample,
    onpreviewsample,
  }: Props = $props();

  /** Press this long without moving to select a passage for the library (ms). */
  const SELECT_HOLD_MS = 2000;
  /** A selection made without dragging is this long (seconds). */
  const DEFAULT_SELECTION = 1;
  /** Longest passage the library takes (seconds). */
  const MAX_SELECTION = 60;
  const MIN_SELECTION = 0.05;

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

  // ------------------------------------------------------------ sample selection

  /** The passage selected for the library (sketch time), while there is one. */
  let selection = $state<{ start: number; end: number } | null>(null);
  /** Dragging out a selection from its anchor, or one of its edges. */
  let selecting: { anchor: number; pointer: number; moved: boolean } | null = null;
  let edgeDrag = $state<{ edge: 'start' | 'end'; pointer: number } | null>(null);
  let selectTimer = 0;
  let ctrlHeld = false;
  let adding = $state(false);

  /** Where the take has sound: a selection stays inside it. */
  const takeSpan = $derived({ start: Math.max(0, offset), end: Math.min(total, offset + (peaks?.duration ?? total)) });

  function clampSelection(a: number, b: number): { start: number; end: number } {
    let start = Math.max(takeSpan.start, Math.min(a, b));
    let end = Math.min(takeSpan.end, Math.max(a, b));
    if (end - start > MAX_SELECTION) end = start + MAX_SELECTION;
    if (end - start < MIN_SELECTION) end = Math.min(takeSpan.end, start + MIN_SELECTION);
    start = Math.max(takeSpan.start, Math.min(start, end - MIN_SELECTION));
    return { start, end };
  }

  /** Begin selecting at `time` (the press stays on the waveform; dragging sets the other edge). */
  function beginSelection(time: number, pointer: number) {
    window.clearTimeout(selectTimer);
    selectTimer = 0;
    endHold();
    scrubbing = false;
    selecting = { anchor: time, pointer, moved: false };
    selection = clampSelection(time, time + MIN_SELECTION);
    navigator.vibrate?.(15);
  }

  function clearSelection() {
    selection = null;
    selecting = null;
    edgeDrag = null;
  }

  async function addSelection() {
    const sel = selection;
    if (!sel || !onaddsample || adding) return;
    adding = true;
    try {
      await onaddsample(sel.start, sel.end);
      clearSelection();
    } finally {
      adding = false;
    }
  }

  function edgeDown(edge: 'start' | 'end', e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    edgeDrag = { edge, pointer: e.pointerId };
  }

  function edgeMove(e: PointerEvent) {
    const d = edgeDrag;
    const sel = selection;
    if (!d || d.pointer !== e.pointerId || !sel) return;
    const t = timeAt(e.clientX);
    selection = d.edge === 'start' ? clampSelection(Math.min(t, sel.end - MIN_SELECTION), sel.end) : clampSelection(sel.start, Math.max(t, sel.start + MIN_SELECTION));
  }

  function edgeUp(e: PointerEvent) {
    if (edgeDrag?.pointer === e.pointerId) edgeDrag = null;
  }

  /** Where the tooltip sits: above the selection (below the waveform if there is no room), inside the window. */
  let tipW = $state(220);
  const tipBox = $derived.by(() => {
    void width;
    if (!selection || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mid = rect.left + (((selection.start + selection.end) / 2) / total) * rect.width;
    const left = Math.max(8, Math.min(window.innerWidth - tipW - 8, mid - tipW / 2));
    const above = rect.top - 52;
    return { left, top: above >= 8 ? above : rect.bottom + 10 };
  });

  onMount(() => {
    if (!onaddsample) return;
    const key = (e: KeyboardEvent) => {
      ctrlHeld = e.ctrlKey;
      if (e.type === 'keydown' && e.key === 'Escape' && selection) clearSelection();
    };
    const blur = () => (ctrlHeld = false);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
      window.removeEventListener('blur', blur);
    };
  });

  onDestroy(() => {
    window.clearTimeout(holdTimer);
    window.clearTimeout(selectTimer);
  });

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
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const t = timeAt(e.clientX);
    if (onaddsample && (e.ctrlKey || ctrlHeld)) {
      // Ctrl: select a passage for the library instead of scrubbing.
      e.preventDefault();
      beginSelection(t, e.pointerId);
      return;
    }
    if (selection) clearSelection();
    scrubbing = true;
    onseek?.(t, true);
    armHold(e.clientX, () => timeAt(e.clientX));
    if (onaddsample) {
      window.clearTimeout(selectTimer);
      // Held still for 2 s: select from here.
      selectTimer = window.setTimeout(() => {
        selectTimer = 0;
        if (scrubbing) beginSelection(timeAt(pressX), e.pointerId);
      }, SELECT_HOLD_MS);
    }
  }
  function onPointerMove(e: PointerEvent) {
    const s = selecting;
    if (s && s.pointer === e.pointerId) {
      const t = timeAt(e.clientX);
      if (Math.abs(t - s.anchor) > 0.02) s.moved = true;
      if (s.moved) selection = clampSelection(s.anchor, t);
      return;
    }
    if (!scrubbing) return;
    const t = timeAt(e.clientX);
    if (selectTimer && Math.abs(e.clientX - pressX) > HOLD_SLOP) {
      window.clearTimeout(selectTimer);
      selectTimer = 0;
    }
    onseek?.(t, true);
    moveHold(e.clientX, t);
  }
  function onPointerUp(e: PointerEvent) {
    const s = selecting;
    if (s && s.pointer === e.pointerId) {
      selecting = null;
      // Let go without dragging: a passage of a second from the press.
      if (!s.moved) selection = clampSelection(s.anchor, s.anchor + DEFAULT_SELECTION);
      return;
    }
    window.clearTimeout(selectTimer);
    selectTimer = 0;
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
      if ((loupe || dragging || selecting || edgeDrag) && e.cancelable) e.preventDefault();
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
      selecting = null;
      window.clearTimeout(selectTimer);
      selectTimer = 0;
      endHold();
    }}
    oncontextmenu={(e) => onaddsample && e.preventDefault()}
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

  {#if selection}
    <!-- The passage selected for the library, with its edges to drag. -->
    <div class="selection" style:left="{(selection.start / total) * 100}%" style:width="{((selection.end - selection.start) / total) * 100}%"></div>
    {#each ['start', 'end'] as const as edge (edge)}
      <div
        class="sel-edge"
        style:left="{((edge === 'start' ? selection.start : selection.end) / total) * 100}%"
        role="slider"
        tabindex="-1"
        aria-label="Selection {edge}"
        aria-valuenow={Math.round((edge === 'start' ? selection.start : selection.end) * 10) / 10}
        onpointerdown={(e) => edgeDown(edge, e)}
        onpointermove={edgeMove}
        onpointerup={edgeUp}
        onpointercancel={edgeUp}
      ></div>
    {/each}
  {/if}
</div>

{#if selection}
  {#if tipBox}
    <div
      class="sample-tip"
      role="toolbar"
      tabindex="-1"
      aria-label="Selected passage"
      bind:clientWidth={tipW}
      style:left="{tipBox.left}px"
      style:top="{tipBox.top}px"
      onpointerdown={(e) => e.stopPropagation()}
    >
      {#if onpreviewsample}
        <button class="tip-icon" onclick={() => selection && onpreviewsample?.(selection.start, selection.end)} aria-label="Hear the selection">
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor" /></svg>
        </button>
      {/if}
      <button class="tip-add" onclick={addSelection} disabled={adding}>{adding ? 'Adding…' : 'Add to library'}</button>
      <span class="tip-len tabular">{formatClockTenths(selection.end - selection.start)}</span>
      <button class="tip-icon" onclick={clearSelection} aria-label="Cancel the selection">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
      </button>
    </div>
  {/if}
{/if}

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
  /* Attached under a piano roll: square at the top, so it reads as one block with the roll. */
  .flush .handle.start .grip {
    border-radius: 0 0 2px var(--radius-sm);
  }
  .flush .handle.end .grip {
    border-radius: 0 0 var(--radius-sm) 2px;
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
  .selection {
    position: absolute;
    top: 0;
    bottom: 0;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    border-left: 2px solid var(--accent);
    border-right: 2px solid var(--accent);
    pointer-events: none;
  }
  .sel-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 24px;
    margin-left: -12px;
    touch-action: none;
    cursor: ew-resize;
    z-index: 2;
  }
  .sample-tip {
    position: fixed;
    z-index: 41;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border-radius: 999px;
    background: var(--ink);
    color: var(--paper);
    box-shadow: var(--shadow);
    white-space: nowrap;
    animation: tip-in 120ms ease;
  }
  @keyframes tip-in {
    from {
      opacity: 0;
      translate: 0 4px;
    }
  }
  .tip-add {
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 600;
    background: var(--accent);
    color: var(--accent-ink);
  }
  .tip-icon {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--paper);
  }
  .tip-len {
    font-size: 0.75rem;
    opacity: 0.8;
    padding: 0 2px;
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
