<script lang="ts">
  /**
   * Interactive piano roll (canvas).
   *  - Review: tap to seek, drag to scroll, pinch / ctrl+wheel to zoom; the
   *    view follows the playhead and lights up sounding notes and keys.
   *  - Edit: tap a note to select it. Dragging a selected note moves the
   *    whole selection (time + pitch), dragging an edge resizes it,
   *    double-tap empty space adds a note, Delete/arrow keys on desktop.
   *    With a finger, a drag scrolls as in review; press and hold first to
   *    draw a selection rectangle (or, on a note, to pick it up). With a
   *    mouse, dragging across empty space selects (Shift adds).
   *  - Compact: a short strip of the notes (a collapsed track).
   *
   * Times: notes are in their take's time; the view (zoom, scroll, playhead,
   * crop) is in sketch time. `offset` is where the take starts in the sketch.
   * Rolls that share a `view` scroll and zoom together.
   */
  import { onMount, untrack } from 'svelte';
  import type { ChordSegment } from '../music/chords';
  import { isBlackKey, noteName, normalizeNote, pitchClass, PIANO_MAX, PIANO_MIN } from '../music/notes';
  import { mergeSelection, notesInBox, shiftNotes, type NoteShift } from '../music/selection';
  import type { PianoNote } from '../transcription/types';
  import { formatClock } from './format';
  import { RollViewport } from './rollViewport.svelte';

  interface Props {
    notes: PianoNote[];
    chords?: ChordSegment[];
    duration: number;
    currentTime: number;
    playing?: boolean;
    editing?: boolean;
    /** Indices of the selected notes (edit mode). */
    selection?: number[];
    onseek?: (time: number) => void;
    /** The notes changed; `focus` are the notes that should be selected afterwards. */
    onchange?: (notes: PianoNote[], focus: PianoNote[]) => void;
    onpreview?: (pitch: number) => void;
    /** A chord in the chord lane was tapped. */
    onchordtap?: (chord: ChordSegment) => void;
    /** Playback crop range (seconds); outside it is dimmed. */
    cropStart?: number | null;
    cropEnd?: number | null;
    /** Where the notes' time 0 lies in sketch time (seconds). */
    offset?: number;
    /** Zoom and scroll, shared with the other tracks' rolls. */
    view?: RollViewport;
    /** A short strip without keyboard, chord lane or ruler (a collapsed track). */
    compact?: boolean;
  }

  let {
    notes,
    chords = [],
    duration,
    currentTime,
    playing = false,
    editing = false,
    selection = $bindable([]),
    onseek,
    onchange,
    onpreview,
    onchordtap,
    cropStart = null,
    cropEnd = null,
    offset = 0,
    view = new RollViewport(),
    compact = false,
  }: Props = $props();

  const GUTTER = 40;
  const CHORD_LANE_H = 26;
  const RULER_H = 16;
  const MIN_PX = 12;
  const MAX_PX = 700;
  /** Press this long without moving to select (or pick up a note) with a finger (ms). */
  const HOLD_MS = 300;

  /** Chord lane height, and where the note rows begin (no lane or ruler when compact). */
  const CHORD_LANE = $derived(compact ? 0 : CHORD_LANE_H);
  const TOP = $derived(compact ? 0 : CHORD_LANE_H + RULER_H);

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let width = $state(0);
  let height = $state(0);
  /** Notes as they would be if the current drag ended now, by index. */
  let dragPreview = $state.raw<Map<number, PianoNote> | null>(null);
  /** Selection rectangle being dragged: time span and vertical pixel span. */
  let marquee = $state<{ t0: number; t1: number; y0: number; y1: number } | null>(null);
  const selectedSet = $derived(new Set(selection));
  let themeVersion = $state(0);

  const notesEnd = $derived(notes.reduce((t, n) => Math.max(t, n.endTime), 0));
  const totalSeconds = $derived(Math.max(duration || 0, notesEnd + offset, 1));
  /** The playhead in the notes' own time. */
  const now = $derived(currentTime - offset);
  const rollWidth = $derived(Math.max(0, width - GUTTER));
  const visibleSeconds = $derived(rollWidth / view.pxPerSec);

  const range = $derived.by(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of notes) {
      lo = Math.min(lo, n.pitch);
      hi = Math.max(hi, n.pitch);
    }
    if (!Number.isFinite(lo)) {
      lo = 48;
      hi = 72;
    }
    const pad = compact ? 1 : editing ? 5 : 2;
    lo -= pad;
    hi += pad;
    const minSpan = compact ? 12 : 25;
    if (hi - lo + 1 < minSpan) {
      const center = (lo + hi) / 2;
      lo = Math.round(center - minSpan / 2);
      hi = lo + minSpan - 1;
    }
    return { lo: Math.max(PIANO_MIN, lo), hi: Math.min(PIANO_MAX, hi) };
  });
  const rowH = $derived(Math.max(compact ? 0.5 : 3, (height - TOP) / (range.hi - range.lo + 1)));

  /** x of a time in the notes' own time. */
  const xOf = (t: number) => GUTTER + (t + offset - view.scrollX) * view.pxPerSec;
  /** Notes' own time at x. */
  const tOf = (x: number) => view.scrollX + (x - GUTTER) / view.pxPerSec - offset;
  /** x of a sketch time (playhead, crop, ruler). */
  const xAt = (t: number) => GUTTER + (t - view.scrollX) * view.pxPerSec;
  /** Sketch time at x. */
  const sOf = (x: number) => view.scrollX + (x - GUTTER) / view.pxPerSec;
  const yOf = (pitch: number) => TOP + (range.hi - pitch) * rowH;
  const pitchOf = (y: number) =>
    Math.max(range.lo, Math.min(range.hi, range.hi - Math.floor((y - TOP) / rowH)));
  const snap = (t: number) => Math.round(t * 100) / 100;
  // Allow a little room past the last note, not a screen of empty paper.
  const clampScroll = (s: number) => Math.max(0, Math.min(s, Math.max(0, totalSeconds - visibleSeconds + 0.5)));

  // ------------------------------------------------------------------ view

  /** Fit short sketches entirely; long ones at a readable zoom. */
  $effect(() => {
    const total = totalSeconds;
    const available = rollWidth;
    untrack(() => {
      if (available <= 0) return;
      const lengthChanged = Math.abs(total - view.fittedFor) / Math.max(1, view.fittedFor) >= 0.2;
      const widthChanged = Math.abs(available - view.fittedWidth) > 1;
      if (!view.userZoomed && (lengthChanged || widthChanged)) {
        // Refit on load, when the length becomes known, and on rotation/resize.
        view.fittedFor = total;
        view.fittedWidth = available;
        view.pxPerSec = Math.max(25, Math.min(160, available / (total * 1.02)));
      }
      view.scrollX = clampScroll(view.scrollX);
    });
  });

  /** Follow the playhead. */
  $effect(() => {
    // Only react to the clock, not to the user scrolling the view.
    const t = currentTime;
    const isPlaying = playing;
    untrack(() => {
      if (rollWidth <= 0 || performance.now() < view.userScrollUntil) return;
      const left = view.scrollX;
      const right = view.scrollX + visibleSeconds;
      if (isPlaying) {
        if (t < left || t > left + visibleSeconds * 0.8) view.scrollX = clampScroll(t - visibleSeconds * 0.2);
      } else if (t < left || t > right) {
        view.scrollX = clampScroll(t - visibleSeconds * 0.3);
      }
    });
  });

  export function zoom(factor: number) {
    const anchor = Math.min(Math.max(currentTime, view.scrollX), view.scrollX + visibleSeconds);
    const anchorX = xAt(anchor);
    view.userZoomed = true;
    view.pxPerSec = Math.max(MIN_PX, Math.min(MAX_PX, view.pxPerSec * factor));
    view.scrollX = clampScroll(anchor - (anchorX - GUTTER) / view.pxPerSec);
  }

  // ------------------------------------------------------------ momentum

  /** Recent pan positions, for a fling when the finger lifts. */
  let panSamples: { t: number; scroll: number }[] = [];
  let flingFrame = 0;

  function stopFling() {
    cancelAnimationFrame(flingFrame);
    flingFrame = 0;
  }

  function startFling() {
    const now = performance.now();
    const recent = panSamples.filter((s) => now - s.t < 100);
    panSamples = [];
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    let velocity = (last.scroll - first.scroll) / Math.max(0.016, (last.t - first.t) / 1000); // s per s
    if (Math.abs(velocity * view.pxPerSec) < 120) return; // slow release: no fling
    let previous = now;
    const step = (frameTime: number) => {
      const dt = Math.min(0.05, (frameTime - previous) / 1000);
      previous = frameTime;
      const next = clampScroll(view.scrollX + velocity * dt);
      const hitEdge = next === view.scrollX;
      view.scrollX = next;
      view.userScrollUntil = performance.now() + 2500;
      velocity *= Math.exp(-dt * 3.5);
      if (!hitEdge && Math.abs(velocity * view.pxPerSec) > 15) flingFrame = requestAnimationFrame(step);
      else flingFrame = 0;
    };
    flingFrame = requestAnimationFrame(step);
  }

  export function fit() {
    view.userZoomed = false;
    view.fittedFor = 0;
    view.pxPerSec = Math.max(MIN_PX, Math.min(160, rollWidth / (totalSeconds * 1.02)));
    view.scrollX = 0;
  }

  // --------------------------------------------------------------- drawing

  interface Palette {
    paper: string;
    raised: string;
    sunk: string;
    ink: string;
    ink2: string;
    ink3: string;
    rule: string;
    accent: string;
    note: string;
    chord: string;
  }
  let palette: Palette | null = null;

  function readPalette(): Palette {
    const cs = getComputedStyle(container);
    const v = (name: string) => cs.getPropertyValue(name).trim() || '#888';
    return {
      paper: v('--paper'),
      raised: v('--paper-raised'),
      sunk: v('--paper-sunk'),
      ink: v('--ink'),
      ink2: v('--ink-2'),
      ink3: v('--ink-3'),
      rule: v('--rule'),
      accent: v('--accent'),
      note: v('--note'),
      chord: v('--chord'),
    };
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
    } else {
      ctx.rect(x, y, w, h);
    }
  }

  function gridStep(): number {
    for (const step of [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) {
      if (step * view.pxPerSec >= 56) return step;
    }
    return 300;
  }

  function draw() {
    if (!canvas || !container || width <= 0 || height <= 0) return;
    void themeVersion;
    palette ??= readPalette();
    const c = palette;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = c.paper;
    ctx.fillRect(0, 0, width, height);

    const { lo, hi } = range;
    // Visible span in sketch time (s0–s1) and in the notes' own time (t0–t1).
    const s0 = view.scrollX;
    const s1 = view.scrollX + visibleSeconds;
    const t0 = s0 - offset;
    const t1 = s1 - offset;

    // Pitch rows.
    for (let p = lo; p <= hi; p++) {
      const y = yOf(p);
      if (isBlackKey(p)) {
        ctx.fillStyle = c.sunk;
        ctx.fillRect(GUTTER, y, rollWidth, rowH);
      }
      if (pitchClass(p) === 0) {
        ctx.fillStyle = c.rule;
        ctx.fillRect(GUTTER, y + rowH - 0.5, rollWidth, 1);
      }
    }

    // Time grid + ruler (sketch time).
    const step = gridStep();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let t = Math.ceil(s0 / step) * step; t <= s1; t += step) {
      const x = Math.round(xAt(t)) + 0.5;
      ctx.fillStyle = c.rule;
      ctx.fillRect(x, TOP, 1, height - TOP);
      if (compact) continue;
      ctx.fillStyle = c.ink3;
      ctx.fillText(step < 1 ? t.toFixed(2).replace(/\.?0+$/, '') + 's' : formatClock(t), x + 3, CHORD_LANE + RULER_H / 2);
    }
    if (!compact) {
      ctx.fillStyle = c.rule;
      ctx.fillRect(GUTTER, TOP - 0.5, rollWidth, 1);
    }

    // Chord lane.
    ctx.font = '600 13px ui-serif, "New York", Georgia, serif';
    for (const chord of compact ? [] : chords) {
      if (chord.endTime < t0 || chord.startTime > t1) continue;
      const active = now >= chord.startTime && now < chord.endTime;
      const x0 = Math.max(GUTTER, xOf(chord.startTime));
      const x1 = Math.min(width, xOf(chord.endTime));
      ctx.fillStyle = active ? c.accent : c.chord;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x0, CHORD_LANE - 4, Math.max(1, x1 - x0 - 3), 2);
      ctx.globalAlpha = 1;
      ctx.fillText(chord.symbol, x0 + 2, CHORD_LANE / 2 - 1);
    }

    // Notes.
    const sounding = new Set<number>();
    const h = compact ? Math.max(1, rowH * 0.85) : Math.max(2, rowH - 1.5);
    for (let i = 0; i < notes.length; i++) {
      const n = dragPreview?.get(i) ?? notes[i];
      if (n.endTime < t0 || n.startTime > t1 || n.pitch < lo || n.pitch > hi) continue;
      const x = xOf(n.startTime);
      const w = Math.max(2, (n.endTime - n.startTime) * view.pxPerSec - 1);
      const y = yOf(n.pitch) + 0.75;
      const active = now >= n.startTime && now < n.endTime;
      if (active) sounding.add(n.pitch);
      ctx.globalAlpha = 0.4 + 0.6 * Math.min(1, n.confidence ?? 1);
      ctx.fillStyle = active ? c.accent : c.note;
      roundRect(ctx, x, y, w, h, compact ? 1 : 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (editing && selectedSet.has(i)) {
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
        // Resize grips.
        ctx.fillStyle = c.paper;
        ctx.fillRect(x + w - 4, y + h / 2 - Math.min(5, h / 3), 2, Math.min(10, (h * 2) / 3));
      }
    }

    // Selection rectangle.
    if (marquee) {
      const x0 = Math.max(GUTTER, xOf(marquee.t0));
      const x1 = Math.min(width, xOf(marquee.t1));
      const w = Math.max(1, x1 - x0);
      const mh = Math.max(1, marquee.y1 - marquee.y0);
      ctx.fillStyle = c.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(x0, marquee.y0, w, mh);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0 + 0.5, marquee.y0 + 0.5, w - 1, mh - 1);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Outside the playback crop range.
    if (cropStart !== null || cropEnd !== null) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = c.paper;
      const a = cropStart ?? 0;
      const b = cropEnd ?? totalSeconds;
      if (a > s0) ctx.fillRect(GUTTER, CHORD_LANE, Math.min(rollWidth, xAt(a) - GUTTER), height - CHORD_LANE);
      if (b < s1) {
        const x = Math.max(GUTTER, xAt(b));
        ctx.fillRect(x, CHORD_LANE, width - x, height - CHORD_LANE);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.chord;
      for (const edge of [cropStart, cropEnd]) {
        if (edge === null || edge < s0 || edge > s1) continue;
        ctx.fillRect(Math.round(xAt(edge)) - 1, CHORD_LANE, 2, height - CHORD_LANE);
      }
    }

    // Playhead.
    if (currentTime >= s0 && currentTime <= s1) {
      const x = Math.round(xAt(currentTime)) + 0.5;
      ctx.fillStyle = c.accent;
      ctx.fillRect(x - 1, CHORD_LANE, 2, height - CHORD_LANE);
      if (!compact) {
        ctx.beginPath();
        ctx.moveTo(x - 5, CHORD_LANE);
        ctx.lineTo(x + 5, CHORD_LANE);
        ctx.lineTo(x, CHORD_LANE + 6);
        ctx.fill();
      }
    }

    // Scroll indicator, so it is clear the roll extends beyond the screen.
    if (!compact && totalSeconds > visibleSeconds * 1.02 && rollWidth > 40) {
      const w = Math.max(24, (visibleSeconds / totalSeconds) * rollWidth);
      const x = GUTTER + (view.scrollX / Math.max(0.001, totalSeconds - visibleSeconds)) * (rollWidth - w);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = c.ink3;
      roundRect(ctx, Math.min(x, width - w - 2), height - 5, w, 3, 1.5);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Keyboard gutter (fixed; a plain margin when compact, to stay lined up with full rolls).
    ctx.fillStyle = c.raised;
    ctx.fillRect(0, 0, GUTTER, height);
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    for (let p = compact ? hi + 1 : lo; p <= hi; p++) {
      const y = yOf(p);
      const lit = sounding.has(p);
      if (isBlackKey(p)) {
        ctx.fillStyle = lit ? c.accent : c.ink;
        ctx.globalAlpha = lit ? 1 : 0.78;
        ctx.fillRect(0, y + 0.5, GUTTER * 0.6, Math.max(1, rowH - 1));
        ctx.globalAlpha = 1;
      } else {
        if (lit) {
          ctx.fillStyle = c.accent;
          ctx.globalAlpha = 0.55;
          ctx.fillRect(0, y, GUTTER, rowH);
          ctx.globalAlpha = 1;
        }
        const below = p - 1;
        if (!isBlackKey(below)) {
          ctx.fillStyle = c.rule;
          ctx.fillRect(0, y + rowH - 0.5, GUTTER, 1);
        }
      }
      if (pitchClass(p) === 0 && rowH >= 6) {
        ctx.fillStyle = c.ink3;
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(p), GUTTER - 18, y + rowH / 2);
      }
    }
    ctx.fillStyle = c.rule;
    ctx.fillRect(GUTTER - 0.5, 0, 1, height);
  }

  $effect(() => {
    draw();
  });

  // ---------------------------------------------------------- interaction

  type Mode = 'pending' | 'pan' | 'marquee' | 'move' | 'start' | 'end';
  type Hit = { index: number; mode: Mode };
  interface Drag {
    pointerId: number;
    mode: Mode;
    /** Note under the pointer when the drag began. */
    index: number | null;
    /** Notes the drag moves or resizes, and how they were when it began. */
    indices: number[];
    originals: PianoNote[];
    startX: number;
    startY: number;
    startScroll: number;
    /** Time under the pointer when the drag began (anchor of the selection rectangle). */
    startT: number;
    /** Selection the rectangle adds to (Shift held), else empty. */
    base: number[];
    /** The pressed note was already one of several selected notes. */
    inGroup: boolean;
    /** A finger on a note that was not selected: a tap selects it, a hold picks it up. */
    held: Hit | null;
    /** Touch or pen: dragging scrolls unless the press is held first. */
    touch: boolean;
    lastX: number;
    lastY: number;
    moved: boolean;
  }
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: Drag | null = null;
  let pinch: { dist: number; px: number; centerT: number } | null = null;
  let lastTap = { time: 0, x: 0, y: 0 };
  let edgeFrame = 0;
  let holdTimer = 0;

  function clearHold() {
    window.clearTimeout(holdTimer);
    holdTimer = 0;
  }

  /** A finger held still: start a selection rectangle, or pick up the note under it. */
  function onHold(pointerId: number) {
    holdTimer = 0;
    const d = drag;
    if (!d || d.pointerId !== pointerId || d.moved || d.mode !== 'pending' || !editing) return;
    navigator.vibrate?.(8);
    if (d.held) {
      const hit = d.held;
      selection = [hit.index];
      drag = { ...d, mode: hit.mode, index: hit.index, indices: [hit.index], originals: [notes[hit.index]], held: null };
      onpreview?.(notes[hit.index].pitch);
      return;
    }
    d.mode = 'marquee';
    marquee = { t0: d.startT, t1: d.startT, y0: d.startY, y1: d.startY };
  }

  function local(e: PointerEvent | WheelEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hitNote(x: number, y: number): Hit | null {
    if (y < TOP || x < GUTTER) return null;
    const pitch = pitchOf(y);
    const t = tOf(x);
    const slop = 6 / view.pxPerSec;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.pitch !== pitch || t < n.startTime - slop || t > n.endTime + slop) continue;
      const xs = xOf(n.startTime);
      const xe = xOf(n.endTime);
      const edge = Math.min(14, (xe - xs) / 3);
      const mode: Mode = x >= xe - edge ? 'end' : x <= xs + edge && xe - xs > 30 ? 'start' : 'move';
      return { index: i, mode };
    }
    return null;
  }

  // ------------------------------------------------- selection rectangle

  function updateMarquee(d: Drag) {
    const t = tOf(Math.max(GUTTER, Math.min(width, d.lastX)));
    const y = Math.max(TOP, Math.min(height, d.lastY));
    const box = {
      t0: Math.min(d.startT, t),
      t1: Math.max(d.startT, t),
      y0: Math.min(d.startY, y),
      y1: Math.max(d.startY, y),
    };
    marquee = box;
    const hits = notesInBox(notes, {
      startTime: box.t0,
      endTime: box.t1,
      pitchLow: pitchOf(box.y1),
      pitchHigh: pitchOf(box.y0),
    });
    selection = d.base.length > 0 ? mergeSelection(d.base, hits) : hits;
  }

  /** Scroll while the selection rectangle is held against the left or right edge. */
  function edgeScroll() {
    edgeFrame = 0;
    const d = drag;
    if (!d || d.mode !== 'marquee') return;
    const margin = 28;
    let push = 0;
    if (d.lastX > width - margin) push = (d.lastX - (width - margin)) / margin;
    else if (d.lastX < GUTTER + margin) push = -(GUTTER + margin - d.lastX) / margin;
    if (push === 0) return;
    const before = view.scrollX;
    view.scrollX = clampScroll(view.scrollX + (Math.max(-1.5, Math.min(1.5, push)) * 12) / view.pxPerSec);
    view.userScrollUntil = performance.now() + 2500;
    if (view.scrollX === before) return;
    updateMarquee(d);
    edgeFrame = requestAnimationFrame(edgeScroll);
  }

  function stopEdgeScroll() {
    cancelAnimationFrame(edgeFrame);
    edgeFrame = 0;
  }

  function cancelDrag() {
    stopEdgeScroll();
    clearHold();
    if (drag?.mode === 'marquee') selection = drag.base;
    drag = null;
    dragPreview = null;
    marquee = null;
  }

  // ------------------------------------------------------------ pointers

  function onPointerDown(e: PointerEvent) {
    stopFling();
    panSamples = [];
    const p = local(e);
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cancelDrag();
      pinch = {
        dist: Math.max(10, Math.abs(a.x - b.x)),
        px: view.pxPerSec,
        centerT: sOf((a.x + b.x) / 2),
      };
      return;
    }
    if (p.x < GUTTER && p.y > TOP && !compact) {
      onpreview?.(pitchOf(p.y));
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    const fresh: Drag = {
      pointerId: e.pointerId,
      mode: 'pending',
      index: null,
      indices: [],
      originals: [],
      startX: p.x,
      startY: p.y,
      startScroll: view.scrollX,
      startT: tOf(p.x),
      base: editing && additive ? selection.filter((i) => i < notes.length) : [],
      inGroup: false,
      held: null,
      touch,
      lastX: p.x,
      lastY: p.y,
      moved: false,
    };
    if (editing && !compact) {
      const hit = hitNote(p.x, p.y);
      if (hit && touch && !selectedSet.has(hit.index)) {
        // A finger on an unselected note: tap selects it, a drag scrolls, a hold picks it up.
        drag = { ...fresh, held: hit };
        holdTimer = window.setTimeout(() => onHold(e.pointerId), HOLD_MS);
        return;
      }
      if (hit) {
        if (additive) {
          // Shift/Cmd/Ctrl-click adds the note to the selection or takes it out.
          selection = selectedSet.has(hit.index)
            ? selection.filter((i) => i !== hit.index)
            : mergeSelection(selection, [hit.index]);
          onpreview?.(notes[hit.index].pitch);
          return;
        }
        const inGroup = selectedSet.has(hit.index) && selection.length > 1;
        if (!selectedSet.has(hit.index)) selection = [hit.index];
        const indices = selection.filter((i) => i < notes.length);
        drag = {
          ...fresh,
          mode: hit.mode,
          index: hit.index,
          indices,
          originals: indices.map((i) => notes[i]),
          inGroup,
        };
        onpreview?.(notes[hit.index].pitch);
        return;
      }
      if (touch && p.y > TOP && p.x >= GUTTER) {
        // Empty space: a drag scrolls; hold first to draw a selection rectangle.
        drag = fresh;
        holdTimer = window.setTimeout(() => onHold(e.pointerId), HOLD_MS);
        return;
      }
    }
    drag = fresh;
  }

  function onPointerMove(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(10, Math.abs(a.x - b.x));
      view.userZoomed = true;
      view.pxPerSec = Math.max(MIN_PX, Math.min(MAX_PX, (pinch.px * dist) / pinch.dist));
      view.scrollX = clampScroll(pinch.centerT - ((a.x + b.x) / 2 - GUTTER) / view.pxPerSec);
      view.userScrollUntil = performance.now() + 2500;
      return;
    }
    if (!drag || drag.pointerId !== e.pointerId) return;
    const d = drag;
    d.lastX = p.x;
    d.lastY = p.y;
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    clearHold();

    if (d.mode === 'pending') {
      // With a mouse, a drag that starts on the roll while editing draws a
      // selection rectangle. A finger (unless held first), the time ruler
      // and review mode scroll.
      d.mode = editing && !d.touch && d.startY > TOP && d.startX >= GUTTER ? 'marquee' : 'pan';
    }
    if (d.mode === 'marquee') {
      updateMarquee(d);
      if (!edgeFrame) edgeFrame = requestAnimationFrame(edgeScroll);
      return;
    }
    if (d.mode === 'pan') {
      view.scrollX = clampScroll(d.startScroll - dx / view.pxPerSec);
      view.userScrollUntil = performance.now() + 2500;
      panSamples.push({ t: performance.now(), scroll: view.scrollX });
      if (panSamples.length > 12) panSamples.shift();
      return;
    }

    const dt = snap(dx / view.pxPerSec);
    const shift: NoteShift =
      d.mode === 'move' ? { time: dt, pitch: -Math.round(dy / rowH) } : d.mode === 'end' ? { end: dt } : { start: dt };
    const moved = shiftNotes(d.originals, shift, totalSeconds + 30);
    const preview = new Map<number, PianoNote>();
    d.indices.forEach((index, k) => preview.set(index, moved[k]));
    const lead = d.index!;
    const previousPitch = (dragPreview?.get(lead) ?? notes[lead]).pitch;
    dragPreview = preview;
    const pitch = preview.get(lead)?.pitch;
    if (pitch !== undefined && pitch !== previousPitch) onpreview?.(pitch);
  }

  function onPointerUp(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      drag = null;
      return;
    }
    const d = drag;
    if (!d || d.pointerId !== e.pointerId) return;
    drag = null;
    stopEdgeScroll();
    clearHold();

    if (d.mode === 'move' || d.mode === 'start' || d.mode === 'end') {
      const preview = dragPreview;
      dragPreview = null;
      if (d.moved && preview) {
        const next = notes.slice();
        for (const [index, note] of preview) next[index] = note;
        onchange?.(next, [...preview.values()]);
      } else if (d.inGroup && d.index !== null) {
        // A tap on one of several selected notes narrows the selection to it.
        selection = [d.index];
      }
      return;
    }
    if (d.mode === 'marquee') {
      marquee = null;
      return;
    }
    if (d.moved) {
      if (d.mode === 'pan') startFling();
      return;
    }

    const t = tOf(d.startX);
    if (d.held && editing) {
      // A tap on a note that was not selected selects it.
      selection = [d.held.index];
      onpreview?.(notes[d.held.index].pitch);
      return;
    }
    // Tap in the chord lane: hand the chord to the parent (e.g. to play it).
    if (d.startY < CHORD_LANE && d.startX >= GUTTER && onchordtap) {
      const chord = chords.find((c) => t >= c.startTime && t < c.endTime);
      if (chord) {
        onchordtap(chord);
        return;
      }
    }
    if (editing && d.startY > TOP) {
      const tapAt = performance.now();
      const isDouble = tapAt - lastTap.time < 380 && Math.hypot(d.startX - lastTap.x, d.startY - lastTap.y) < 24;
      lastTap = { time: isDouble ? 0 : tapAt, x: d.startX, y: d.startY };
      if (isDouble) {
        const pitch = pitchOf(d.startY);
        const start = snap(Math.max(0, t));
        const added = normalizeNote({ pitch, startTime: start, endTime: start + 0.4, velocity: 80, confidence: 1 });
        onchange?.([...notes, added], [added]);
        onpreview?.(pitch);
      } else if (d.base.length === 0) {
        selection = [];
      }
      return;
    }
    if (d.startX >= GUTTER) onseek?.(Math.max(0, Math.min(totalSeconds, sOf(d.startX))));
  }

  function onPointerCancel(e: PointerEvent) {
    pointers.delete(e.pointerId);
    cancelDrag();
    if (pointers.size < 2) pinch = null;
  }

  function onWheel(e: WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const p = local(e);
      const anchor = sOf(p.x);
      view.userZoomed = true;
      view.pxPerSec = Math.max(MIN_PX, Math.min(MAX_PX, view.pxPerSec * Math.exp(-e.deltaY * 0.01)));
      view.scrollX = clampScroll(anchor - (p.x - GUTTER) / view.pxPerSec);
      return;
    }
    // Horizontal scrolling only; vertical wheel keeps scrolling the page.
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (Math.abs(dx) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      view.scrollX = clampScroll(view.scrollX + dx / view.pxPerSec);
      view.userScrollUntil = performance.now() + 2500;
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!editing || compact) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selection = notes.map((_, i) => i);
      return;
    }
    const indices = selection.filter((i) => i < notes.length);
    if (indices.length === 0) return;
    const coarse = e.shiftKey;
    let shift: NoteShift;
    switch (e.key) {
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        const gone = new Set(indices);
        selection = [];
        onchange?.(notes.filter((_, i) => !gone.has(i)), []);
        return;
      }
      case 'ArrowUp':
        shift = { pitch: coarse ? 12 : 1 };
        break;
      case 'ArrowDown':
        shift = { pitch: coarse ? -12 : -1 };
        break;
      case 'ArrowLeft':
        shift = e.altKey ? { end: -0.05 } : { time: -0.05 };
        break;
      case 'ArrowRight':
        shift = e.altKey ? { end: 0.05 } : { time: 0.05 };
        break;
      case 'Escape':
        selection = [];
        return;
      default:
        return;
    }
    e.preventDefault();
    const originals = indices.map((i) => notes[i]);
    const moved = shiftNotes(originals, shift, totalSeconds + 30);
    const updated = notes.slice();
    indices.forEach((index, k) => (updated[index] = moved[k]));
    onchange?.(updated, moved);
    if (indices.length === 1 && moved[0].pitch !== originals[0].pitch) onpreview?.(moved[0].pitch);
  }

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      width = entry.contentRect.width;
      height = entry.contentRect.height;
    });
    observer.observe(container);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => {
      palette = null;
      themeVersion++;
    };
    media.addEventListener('change', onTheme);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // The page may scroll vertically under a finger (touch-action: pan-y),
    // except while a finger draws a selection, drags notes or pinches.
    const onTouch = (e: TouchEvent) => {
      const m = drag?.mode;
      if ((pinch || m === 'marquee' || m === 'move' || m === 'start' || m === 'end') && e.cancelable) e.preventDefault();
    };
    canvas.addEventListener('touchstart', onTouch, { passive: false });
    canvas.addEventListener('touchmove', onTouch, { passive: false });
    return () => {
      stopFling();
      stopEdgeScroll();
      clearHold();
      canvas.removeEventListener('touchstart', onTouch);
      canvas.removeEventListener('touchmove', onTouch);
      observer.disconnect();
      media.removeEventListener('change', onTheme);
      canvas.removeEventListener('wheel', onWheel);
    };
  });
</script>

<div class="roll" bind:this={container}>
  <canvas
    bind:this={canvas}
    tabindex="0"
    aria-label={compact ? 'Notes (collapsed track)' : editing ? 'Piano roll editor' : 'Piano roll'}
    style:touch-action="pan-y"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onkeydown={onKeyDown}
  ></canvas>
</div>

<style>
  .roll {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 180px;
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--rule);
    background: var(--paper);
  }

  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    outline: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  canvas:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
</style>
