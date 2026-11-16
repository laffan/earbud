<script lang="ts">
  /**
   * The whole notebook in a strip: every sketch, the text notes (a note that
   * is only emoji shows its emoji, small), the part of the canvas in view
   * (everything outside it faded),
   * the playhead and, with repeat on, the loop range. Drag on it to
   * move the view there; drag the loop's handles to change what repeats.
   */
  import { TILE_H, type CanvasView } from './canvasGeometry';

  interface Item {
    id: string;
    start: number;
    end: number;
    y: number;
    rhythm: boolean;
  }

  interface NoteItem {
    id: string;
    /** Where it sits on the timeline, and how long its box is at the current zoom (seconds). */
    start: number;
    width: number;
    y: number;
    height: number;
    /** The emoji of a note that is only emoji. */
    emoji: string | null;
  }

  interface Props {
    items: Item[];
    notes?: NoteItem[];
    view: CanvasView;
    /** Size of the canvas area in view (px, below the ruler). */
    viewWidth: number;
    viewHeight: number;
    playhead: number;
    /** The loop range, shown (with handles) while repeat is on. */
    loop: { start: number; end: number } | null;
    /** Put the view's centre at a point of the canvas (seconds, canvas px). */
    onnavigate: (time: number, y: number) => void;
    onloopchange: (start: number, end: number, done: boolean) => void;
    theme: number;
  }

  let { items, notes = [], view, viewWidth, viewHeight, playhead, loop, onnavigate, onloopchange, theme }: Props = $props();

  const HEIGHT = 54;
  const MIN_LOOP = 0.25;
  /** How much of the minimap's background is laid over the parts out of view. */
  const FADE = 0.62;
  let width = $state(0);
  let canvas = $state<HTMLCanvasElement | null>(null);

  const viewEnd = $derived(view.scrollX + viewWidth / view.pps);
  const viewBottom = $derived(view.scrollY + viewHeight);
  /** The world shown: everything placed, the view, the loop, with a little room after. */
  const world = $derived.by(() => {
    const ends = [...items.map((i) => i.end), ...notes.map((n) => n.start + n.width)];
    const x0 = Math.min(0, view.scrollX, ...items.map((i) => i.start));
    const last = Math.max(30, viewEnd, playhead, loop?.end ?? 0, ...ends);
    const x1 = last + (last - x0) * 0.06;
    const y0 = Math.min(0, view.scrollY);
    const y1 = Math.max(400, viewBottom, ...items.map((i) => i.y + TILE_H), ...notes.map((n) => n.y + n.height)) + 40;
    return { x0, x1, y0, y1 };
  });
  const mx = (t: number) => ((t - world.x0) / (world.x1 - world.x0)) * width;
  const my = (y: number) => ((y - world.y0) / (world.y1 - world.y0)) * HEIGHT;

  function color(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  $effect(() => {
    const el = canvas;
    void theme;
    if (!el || width <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = Math.round(width * dpr);
    el.height = Math.round(HEIGHT * dpr);
    const g = el.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, HEIGHT);
    if (loop) {
      g.fillStyle = color('--accent-soft', '#c8453a22');
      g.fillRect(mx(loop.start), 0, Math.max(1, mx(loop.end) - mx(loop.start)), HEIGHT);
    }
    const note = color('--note', '#2e4a66');
    const chord = color('--chord', '#6d5226');
    for (const item of items) {
      g.fillStyle = item.rhythm ? chord : note;
      g.globalAlpha = 0.75;
      const h = Math.max(2.5, my(item.y + TILE_H) - my(item.y));
      g.fillRect(mx(item.start), my(item.y), Math.max(2, mx(item.end) - mx(item.start)), h);
    }
    // Notes: a faint block, or their emoji.
    const faint = color('--ink-3', '#8c8478');
    for (const note of notes) {
      if (note.emoji) {
        g.globalAlpha = 1;
        g.font = '12px system-ui, sans-serif';
        g.textBaseline = 'top';
        g.fillText(note.emoji, mx(note.start), Math.max(0, Math.min(HEIGHT - 13, my(note.y))));
      } else {
        g.fillStyle = faint;
        g.globalAlpha = 0.45;
        g.fillRect(mx(note.start), my(note.y), Math.max(3, mx(note.start + note.width) - mx(note.start)), Math.max(2, my(note.y + note.height) - my(note.y)));
      }
    }
    // The view: everything outside it is faded (no outline).
    const vx = Math.max(0, mx(view.scrollX));
    const vy = Math.max(0, my(view.scrollY));
    const vw = Math.max(4, Math.min(width, mx(viewEnd)) - vx);
    const vh = Math.max(4, Math.min(HEIGHT, my(viewBottom)) - vy);
    g.fillStyle = color('--paper-sunk', '#ede7db');
    g.globalAlpha = FADE;
    g.beginPath();
    g.rect(0, 0, width, HEIGHT);
    g.rect(vx, vy, vw, vh);
    g.fill('evenodd');
    g.globalAlpha = 1;
    // The playhead.
    g.fillStyle = color('--accent', '#c8453a');
    g.fillRect(Math.round(mx(playhead)) - 1, 0, 2, HEIGHT);
  });

  let drag: { kind: 'view' } | { kind: 'start' | 'end'; pointer: number } | null = null;
  let host: HTMLDivElement;

  function worldAt(e: PointerEvent): { time: number; y: number } {
    const rect = host.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
    const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
    return { time: world.x0 + fx * (world.x1 - world.x0), y: world.y0 + fy * (world.y1 - world.y0) };
  }

  function down(e: PointerEvent) {
    const handle = (e.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle;
    host.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (loop && (handle === 'start' || handle === 'end')) {
      drag = { kind: handle, pointer: e.pointerId };
      return;
    }
    drag = { kind: 'view' };
    const at = worldAt(e);
    onnavigate(at.time, at.y);
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    const at = worldAt(e);
    if (drag.kind === 'view') onnavigate(at.time, at.y);
    else if (loop) {
      const t = Math.max(0, at.time);
      if (drag.kind === 'start') onloopchange(Math.min(t, loop.end - MIN_LOOP), loop.end, false);
      else onloopchange(loop.start, Math.max(t, loop.start + MIN_LOOP), false);
    }
  }

  function up() {
    if (drag && drag.kind !== 'view' && loop) onloopchange(loop.start, loop.end, true);
    drag = null;
  }
</script>

<div
  class="minimap"
  bind:this={host}
  bind:clientWidth={width}
  style:height="{HEIGHT}px"
  role="slider"
  tabindex="-1"
  aria-label="Notebook overview"
  aria-valuenow={Math.round(view.scrollX)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <canvas bind:this={canvas} style:width="{width}px" style:height="{HEIGHT}px"></canvas>
  {#if loop}
    <div class="handle start" data-handle="start" style:left="{mx(loop.start)}px" aria-label="Loop start"><span></span></div>
    <div class="handle end" data-handle="end" style:left="{mx(loop.end)}px" aria-label="Loop end"><span></span></div>
  {/if}
</div>

<style>
  .minimap {
    position: relative;
    border-radius: 9px;
    background: var(--paper-sunk);
    border: 1px solid var(--rule);
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    cursor: pointer;
  }
  canvas {
    display: block;
  }
  .handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 24px;
    margin-left: -12px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
  }
  .handle span {
    width: 6px;
    height: 70%;
    border-radius: 3px;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--paper-raised);
    pointer-events: none;
  }
</style>
