<script lang="ts" module>
  import type { CanvasView } from './canvasGeometry';

  /** Each notebook's view (scroll, zoom, repeat), kept while a sketch is open and across reloads. */
  interface SavedView {
    view: CanvasView;
    repeat: boolean;
  }
  const VIEWS_KEY = 'earbud.canvasViews.v1';
  const savedViews = new Map<string, SavedView>();
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    if (raw) for (const [id, v] of Object.entries(JSON.parse(raw) as Record<string, SavedView>)) savedViews.set(id, v);
  } catch {
    // storage unavailable
  }
  let persistTimer: number | undefined;
  function persistViews() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(savedViews)));
      } catch {
        // storage unavailable
      }
    }, 400);
  }
</script>

<script lang="ts">
  /**
   * A notebook: an endless canvas whose horizontal axis is one timeline.
   * Sketches sit on it where they were made (anywhere vertically), and the
   * playhead plays every sketch it crosses, together, like tracks.
   *
   * - Press and hold on empty canvas: Record audio, Import audio or Record
   *   rhythm, placed at that point. Recording plays the canvas from there,
   *   so a new sketch can be played over what is already on it.
   * - Tap empty canvas: move the playhead there. Tap a sketch: hear it on
   *   its own. Double-tap: open it. Hold a sketch: pick it up and move it
   *   (let go without moving for its menu). Drag a rhythm's right edge to
   *   repeat it.
   * - Drag to scroll, pinch (or ctrl/⌘ + wheel) to zoom the timeline.
   *
   * The minimap and the control bar (play, repeat) stay at the bottom.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { computePeaks } from '../audio/peaks';
  import type { Sketch } from '../library/types';
  import { renderRhythm, RHYTHM_TAIL } from '../music/drums';
  import { barSeconds, MAX_LENGTH_BARS, normalizePattern, playSeconds, type RhythmPattern } from '../music/rhythm';
  import { nearestBeat } from '../music/tempo';
  import { MAX_CANVAS_REPEATS } from '../library/types';
  import { AudioEngine, type EngineTrack } from '../playback/audioEngine';
  import { loadCanvasSound } from '../playback/canvasAudio';
  import type { PianoNote } from '../transcription/types';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import CanvasNote from './CanvasNote.svelte';
  import CanvasTile from './CanvasTile.svelte';
  import { clampView, fitView, NOTE_W, RULER_H, rulerStep, sketchSpan, TILE_H, zoomAround, type Span } from './canvasGeometry';
  import { isEmojiOnly } from './markdown';
  import { sliceCrops, sliceRange, sliceRhythm, snapSlice } from './slice';
  import { displayTitle, formatClock, formatClockTenths } from './format';
  import Icon from './Icon.svelte';
  import ImportSheet from './ImportSheet.svelte';
  import Minimap from './Minimap.svelte';
  import RecordingStrip from './RecordingStrip.svelte';
  import RhythmModal from './RhythmModal.svelte';
  import SettingsSheet from './SettingsSheet.svelte';
  import Sheet from './Sheet.svelte';

  /** Peaks per second drawn on the tiles. */
  const PEAK_RATE = 100;
  const LONG_PRESS_MS = 480;
  const DOUBLE_TAP_MS = 280;
  /** Movement that makes a press a drag (px). */
  const SLOP = 8;

  const notebook = $derived(app.notebook);
  /** Everything on the canvas: sketches that sound, and text notes. */
  const items = $derived(app.canvasSketches);
  const sketches = $derived(items.filter((s) => s.kind !== 'text'));
  const textNotes = $derived(items.filter((s) => s.kind === 'text'));

  // ------------------------------------------------------------ sound

  /** Each sketch's sound: a recording decoded, or a rhythm rendered. */
  let buffers = $state.raw<Record<string, AudioBuffer>>({});
  /** Recordings being decoded or that failed (with the analysis audio tried); rhythms by the pattern rendered. */
  let decoding = $state.raw<Record<string, { state: 'loading' | 'failed' | 'ready'; key: string }>>({});
  let peaks = $state.raw<Record<string, Float32Array>>({});
  let previewNotes = $state.raw<Record<string, PianoNote[]>>({});
  let lengths = $state.raw<Record<string, number>>({});
  let currentTime = $state(0);
  let playing = $state(false);
  let buffering = $state(false);
  let disposed = false;

  /** Playing one sketch on its own (a tap on it), and where the canvas playhead was. */
  let solo = $state<{ id: string; start: number; end: number; resume: number } | null>(null);
  /** Recording onto the canvas from here (seconds), while it lasts. */
  let recordingAt = $state<number | null>(null);
  /** A recording onto this notebook's canvas is under way (shown as a strip on it). */
  const recordingHere = $derived(recordingAt !== null && !!app.recording?.canvas);
  let repeat = $state(false);
  /** The loop range while its handles are dragged. */
  let loopDraft = $state<{ start: number; end: number } | null>(null);

  function makeEngine(): AudioEngine {
    const made: AudioEngine = new AudioEngine({
      onState: (state) => {
        if (made !== engine) return;
        const was = playing;
        currentTime = state.position;
        buffering = state.buffering;
        playing = state.playing;
        // A sketch played on its own has finished: the playhead goes back.
        if (was && !state.playing && solo) untrack(() => endSolo());
      },
      onFrame: (position) => followPlayhead(position),
      log: (message) => app.logCapture(`[canvas] ${message}`),
    });
    return made;
  }
  let engine = makeEngine();

  /**
   * The canvas outlives the recording screen (it is hidden, not closed). On
   * iOS the native recorder takes the audio session, and WebKit can leave an
   * audio context created before it suspended, "interrupted" or silent. So
   * after a recording, after the app comes back from the background, and
   * after a play that never got the audio running, the next tap starts a
   * fresh context (inside the tap, so WebKit lets it start). Decoded buffers
   * belong to no context and are reused.
   */
  let audioStale = false;

  function renewAudio(reason: string) {
    const old = engine;
    const at = solo ? solo.resume : currentTime;
    if (solo) solo = null;
    old.pause();
    engine = makeEngine();
    old.dispose();
    audioStale = false;
    app.logCapture(`[canvas] new audio context (${reason}; the last one was ${old.contextState})`);
    engine.setTracks(engineTracks);
    engine.setDuration(engineDuration);
    applyRange();
    engine.seek(at);
  }

  /** In a tap that leads to sound: a fresh context if the last one may be stuck, then wake it. */
  function wakeAudio() {
    const state = engine.contextState;
    if (audioStale || state === 'closed' || state === 'interrupted') renewAudio(audioStale ? 'after a recording or a pause in the background' : `context ${state}`);
    engine.unlock();
  }

  let watchdog: number | undefined;
  /** Log what playing found, and if no sound has started after a while, say so and use a fresh context next time. */
  function watchStart(what: string) {
    const ready = engineTracks.filter((t) => t.buffer).length;
    const failed = sketches.filter((s) => decoding[s.id]?.state === 'failed').length;
    app.logCapture(
      `[canvas] ${what} from ${currentTime.toFixed(2)} s: context ${engine.contextState}, ${ready} of ${engineTracks.length} tracks ready` +
        (failed ? `, ${failed} could not be decoded` : ''),
    );
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      if (!playing || !buffering) return;
      app.logCapture(`[canvas] still no sound after 2 s (context ${engine.contextState}); a fresh context on the next tap`);
      audioStale = true;
      engine.pause();
      app.toast('The sound did not start. Tap play again.', 'error');
    }, 2000);
  }

  function patternOf(s: Sketch): RhythmPattern | null {
    return s.kind === 'rhythm' ? normalizePattern(s.rhythm) : null;
  }

  // Revision changes include saved edits and active-take changes. A mode
  // change invalidates the old sound immediately; late renders cannot put it back.
  $effect(() => {
    const wanted = sketches.map((s) => ({
      s,
      key: s.kind === 'rhythm' ? JSON.stringify(s.rhythm) :
        JSON.stringify([s.listenMode, s.analysisPath, s.transcriptionStatus, s.updatedAt, app.revision[s.id] ?? 0]),
    }));
    untrack(() => {
      const capture = app.exportDeps().capture;
      for (const { s, key } of wanted) {
        if (decoding[s.id]?.key === key) continue;
        const id = s.id;
        decoding = { ...decoding, [id]: { state: 'loading', key } };
        const { [id]: _old, ...rest } = buffers;
        buffers = rest;
        previewNotes = { ...previewNotes, [id]: [] };
        const pattern = patternOf(s);
        const pending = pattern
          ? renderRhythm(engine.context, pattern).then((buffer) => ({ buffer, recording: null, notes: [], duration: playSeconds(pattern) }))
          : loadCanvasSound(engine.context, s, app.library, {
              exportAudio: capture?.exportAudio ? (media, out) => capture.exportAudio!(media, out) : undefined,
              log: (message) => app.logCapture(`[canvas] ${message}`),
            });
        pending.then(
          (sound) => {
            if (disposed || decoding[id]?.key !== key) return;
            buffers = { ...buffers, [id]: sound.buffer };
            lengths = { ...lengths, [id]: sound.duration };
            previewNotes = { ...previewNotes, [id]: sound.notes };
            if (sound.recording) {
              peaks = { ...peaks, [id]: computePeaks(sound.recording.getChannelData(0), Math.max(1, Math.round(sound.recording.duration * PEAK_RATE))) };
            }
            decoding = { ...decoding, [id]: { state: 'ready', key } };
          },
          (error) => {
            if (disposed || decoding[id]?.key !== key) return;
            app.logCapture(`[canvas] could not prepare ${id}: ${errorMessage(error)}`);
            decoding = { ...decoding, [id]: { state: 'failed', key } };
          },
        );
      }
      const keep = new Set(wanted.map((w) => w.s.id));
      buffers = Object.fromEntries(Object.entries(buffers).filter(([id]) => keep.has(id)));
      peaks = Object.fromEntries(Object.entries(peaks).filter(([id]) => keep.has(id)));
      previewNotes = Object.fromEntries(Object.entries(previewNotes).filter(([id]) => keep.has(id)));
      lengths = Object.fromEntries(Object.entries(lengths).filter(([id]) => keep.has(id)));
      decoding = Object.fromEntries(Object.entries(decoding).filter(([id]) => keep.has(id)));
    });
  });

  const spans = $derived<Record<string, Span>>(
    Object.fromEntries(items.map((s) => [s.id, sketchSpan(s, s.kind === 'audio' ? lengths[s.id] : undefined)])),
  );
  const itemsEnd = $derived(
    sketches.reduce((end, s) => Math.max(end, spans[s.id].end + (s.kind === 'rhythm' ? RHYTHM_TAIL : 0)), 0),
  );
  const extent = $derived.by(() => {
    if (sketches.length === 0) return null;
    const start = Math.min(...sketches.map((s) => spans[s.id].start));
    const end = Math.max(...sketches.map((s) => spans[s.id].end));
    return end - start >= 0.25 ? { start, end } : null;
  });
  const customLoop = $derived(notebook?.loopStartMs != null && notebook.loopEndMs != null);
  /** What repeat plays: the notebook's range, or from the first sketch to the end of the last. */
  const loopRange = $derived(
    loopDraft ?? (customLoop ? { start: notebook!.loopStartMs! / 1000, end: notebook!.loopEndMs! / 1000 } : extent),
  );

  const engineTracks = $derived<EngineTrack[]>(
    sketches.flatMap((s) => {
      const span = spans[s.id];
      const buffer = buffers[s.id] ?? null;
      const rhythm = s.kind === 'rhythm';
      const track = {
        buffer,
        loading: !buffer && decoding[s.id]?.state !== 'failed',
        // A recording plays from its downbeat (or crop) to its end (or crop); a rhythm rings out.
        start: rhythm ? undefined : span.from,
        end: rhythm ? undefined : span.to,
        audible: !solo || solo.id === s.id,
        volume: s.canvasVolume ?? 1,
      };
      // Each repeat of a recording is one more track on the same buffer, a part's length later: all on one clock.
      return Array.from({ length: span.repeats }, (_, k) => ({
        ...track,
        id: k === 0 ? s.id : `${s.id}#${k}`,
        offset: span.origin + k * span.cycle,
      }));
    }),
  );
  $effect(() => {
    const list = engineTracks;
    untrack(() => engine.setTracks(list));
  });

  /** Seeking past the last sketch is allowed (the playhead just sits there). */
  let parkedAt = $state(0);
  const engineDuration = $derived(
    Math.max(itemsEnd, parkedAt, recordingAt !== null ? recordingAt + 3600 : 0, repeat && loopRange ? loopRange.end : 0),
  );
  $effect(() => {
    engine.setDuration(engineDuration);
  });

  /**
   * Range and loop for what plays: a sketch alone, the canvas while recording, or the canvas with repeat
   * (the loop range only, so the engine keeps the playhead in it and play from elsewhere starts at its start).
   */
  function applyRange() {
    if (recordingAt !== null) {
      engine.setRange(0, null);
      engine.setLoop(false);
    } else if (solo) {
      engine.setRange(solo.start, solo.end);
      engine.setLoop(false);
    } else if (repeat && loopRange) {
      // Only the loop plays: the playhead is kept inside it (play from outside starts at its start).
      engine.setRange(loopRange.start, loopRange.end);
      engine.setLoop(true, loopRange.start);
    } else {
      engine.setRange(0, null);
      engine.setLoop(false);
    }
  }
  $effect(() => {
    void [recordingAt, solo, repeat, loopRange?.start, loopRange?.end];
    untrack(applyRange);
  });

  function seekTo(t: number) {
    const time = Math.max(0, t);
    if (solo) endSolo(false);
    if (time > itemsEnd) {
      parkedAt = time;
      engine.setDuration(Math.max(itemsEnd, time));
    }
    engine.seek(time);
  }

  function togglePlay() {
    if (sketches.length === 0) return;
    wakeAudio();
    if (solo) {
      endSolo();
      engine.play();
      watchStart('play');
      return;
    }
    engine.toggle();
    if (playing) watchStart('play');
  }

  /** A tap on a sketch: play it on its own, or stop it if it is playing. */
  function playAlone(id: string) {
    const s = sketches.find((x) => x.id === id);
    const span = spans[id];
    if (!s || !span) return;
    if (solo?.id === id && playing) {
      endSolo();
      return;
    }
    const resume = solo ? solo.resume : currentTime;
    solo = null;
    engine.pause();
    solo = { id, start: span.start, end: span.end + (s.kind === 'rhythm' ? RHYTHM_TAIL : 0), resume };
    applyRange();
    engine.seek(span.start);
    engine.play();
    watchStart('play alone');
  }

  /** Stop playing a sketch on its own; the playhead goes back to where it was. */
  function endSolo(restore = true) {
    const was = solo;
    if (!was) return;
    solo = null;
    engine.pause();
    applyRange();
    if (restore) engine.seek(was.resume);
  }

  // ------------------------------------------------------------- view

  let canvasEl: HTMLDivElement;
  let cw = $state(0);
  let ch = $state(0);
  let view = $state<CanvasView>({ scrollX: -1, scrollY: -24, pps: 28 });
  let viewFor: string | null = null;
  let theme = $state(0);
  let interacting = false;

  // Each notebook opens where it was left (or fitted, the first time).
  $effect(() => {
    const id = notebook?.id ?? null;
    const width = cw;
    untrack(() => {
      if (id === viewFor || !id || width === 0) return;
      if (viewFor) savedViews.set(viewFor, { view, repeat });
      viewFor = id;
      const saved = savedViews.get(id);
      if (saved) {
        view = clampView(saved.view);
        repeat = saved.repeat;
      } else {
        fit();
        repeat = false;
      }
      if (solo) endSolo(false);
      engine.pause();
      engine.seek(0);
    });
  });
  $effect(() => {
    const id = notebook?.id;
    const v = view;
    const r = repeat;
    if (id && id === viewFor) {
      savedViews.set(id, { view: v, repeat: r });
      persistViews();
    }
  });

  function fit() {
    view = fitView(
      items.map((s) => ({ start: spans[s.id].start, end: spans[s.id].end, y: s.canvasY })),
      cw,
      Math.max(0, ch - RULER_H),
    );
  }

  /** While playing, the view pages along with the playhead (not while the canvas is being handled). */
  function followPlayhead(position: number) {
    if (solo || interacting || cw === 0) return;
    const x = (position - view.scrollX) * view.pps;
    if (x > cw * 0.88 || x < 0) view = clampView({ ...view, scrollX: position - (cw * 0.12) / view.pps });
  }

  const playheadTime = $derived(solo ? solo.resume : currentTime);
  const playheadX = $derived((playheadTime - view.scrollX) * view.pps);
  const viewLeft = $derived(view.scrollX * view.pps);
  const ticks = $derived.by(() => {
    if (cw === 0) return [];
    const step = rulerStep(view.pps);
    const out: { t: number; x: number; label: string }[] = [];
    const first = Math.max(0, Math.ceil(view.scrollX / step) * step);
    for (let t = first; t <= view.scrollX + cw / view.pps; t += step) {
      out.push({ t, x: (t - view.scrollX) * view.pps, label: step < 1 ? formatClockTenths(t) : formatClock(t) });
    }
    return out;
  });

  function localPoint(clientX: number, clientY: number) {
    const rect = canvasEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return { x, y, time: view.scrollX + x / view.pps, canvasY: view.scrollY + (y - RULER_H) };
  }

  // ---------------------------------------------------------- gestures

  type Target = { kind: 'empty' } | { kind: 'tile'; id: string } | { kind: 'resize'; id: string };
  interface Press {
    pointer: number;
    type: string;
    x0: number;
    y0: number;
    target: Target;
    moved: boolean;
    held: boolean;
    mode: 'none' | 'pan' | 'drag' | 'resize' | 'slice';
    view0: CanvasView;
    /** A menu was open: this press only closes it. */
    dismiss: boolean;
  }
  const pointers = new Map<number, { x: number; y: number }>();
  let press: Press | null = null;
  let pinch: { d0: number; cx0: number; cy0: number; view0: CanvasView } | null = null;
  let holdTimer: number | undefined;
  let lastTap: { id: string; at: number; timer: number } | null = null;
  let lastPointerType = 'mouse';

  /** A sketch being moved: where its playing part starts (seconds) and its top (px). */
  let dragging = $state<{ id: string; start: number; y: number } | null>(null);
  /** The text note being edited, or one being written at a point (not saved until it has text). */
  let editingNote = $state<string | null>(null);
  let draftNote = $state<{ at: number; canvasY: number } | null>(null);
  /** A note's box while its corner is dragged, and its size when the drag began. */
  let resizingNote = $state<{ id: string; w: number; h: number } | null>(null);
  let noteBox0: { w: number; h: number } | null = null;
  /** The last tap on empty canvas, to tell a double tap (a new note). */
  let lastEmptyTap: { x: number; y: number; at: number; before: number } | null = null;

  /** A sketch being stretched by its right edge: how many bars (a rhythm) or repeats (a recording) it will play. */
  let resizing = $state<{ id: string; count: number } | null>(null);

  function targetOf(el: EventTarget | null): Target {
    const node = el as HTMLElement | null;
    const grip = node?.closest<HTMLElement>('[data-resize]');
    if (grip) return { kind: 'resize', id: grip.dataset.resize! };
    const tile = node?.closest<HTMLElement>('[data-tile]');
    if (tile) return { kind: 'tile', id: tile.dataset.tile! };
    return { kind: 'empty' };
  }

  const menuOpen = () => createMenu !== null || tileMenu !== null || showNotebooks;
  function closeMenus() {
    createMenu = null;
    tileMenu = null;
    showNotebooks = false;
  }

  /** A press that closed a menu does nothing else. */
  let dismissedBy = -1;
  function onWindowDown(e: PointerEvent) {
    if (!menuOpen()) return;
    if ((e.target as HTMLElement).closest('.popover, .dropdown, .picker .title')) return;
    dismissedBy = e.pointerId;
    closeMenus();
  }

  function down(e: PointerEvent) {
    lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvasEl.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    interacting = true;
    if (pointers.size === 2) {
      // A second finger: pinch, and forget the press.
      window.clearTimeout(holdTimer);
      dragging = null;
      resizing = null;
      press = null;
      const [a, b] = [...pointers.values()];
      const c = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), cx0: c.x, cy0: c.y, view0: view };
      return;
    }
    if (pointers.size > 2) return;
    let dismiss = dismissedBy === e.pointerId;
    dismissedBy = -1;
    if (recordingHere) {
      // Recording onto the canvas: it can be scrolled and zoomed, nothing else.
      press = { pointer: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, target: { kind: 'empty' }, moved: false, held: false, mode: 'none', view0: view, dismiss: true };
      return;
    }
    if (editingNote || draftNote) {
      // Finish the note being written (saved on blur); this press does nothing else.
      (document.activeElement as HTMLElement | null)?.blur?.();
      dismiss = true;
    }
    const target = targetOf(e.target);
    if (slicing && target.kind !== 'empty' && target.id === slicing.id) {
      // Slicing: a press on the sketch puts the cut there, and dragging moves it.
      press = { pointer: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, target, moved: false, held: false, mode: 'slice', view0: view, dismiss };
      moveSlice(e.clientX, e.clientY);
      return;
    }
    noteBox0 = null;
    if (target.kind === 'resize' && textNotes.some((n) => n.id === target.id)) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-tile="${target.id}"]`);
      if (el) noteBox0 = { w: el.offsetWidth, h: el.offsetHeight };
    }
    press = {
      pointer: e.pointerId,
      type: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      target,
      moved: false,
      held: false,
      mode: 'none',
      view0: view,
      dismiss,
    };
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(onHold, LONG_PRESS_MS);
  }

  function onHold() {
    const p = press;
    if (!p || p.moved) return;
    p.held = true;
    if (p.target.kind === 'empty') {
      if (p.dismiss) return;
      const at = localPoint(p.x0, p.y0);
      openCreateMenu(p.x0, p.y0, at.time, at.canvasY);
      press = null;
      navigator.vibrate?.(12);
    } else {
      // A sketch or note (or its grip): picked up, with its menu. Moving closes the menu and drags.
      const id = p.target.id;
      const s = items.find((x) => x.id === id);
      if (!s) return;
      p.mode = 'drag';
      dragging = { id: s.id, start: spans[s.id].start, y: s.canvasY };
      openTileMenu(id, p.x0, p.y0);
      navigator.vibrate?.(12);
    }
  }

  function move(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const c = localPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      const zoomed = zoomAround(pinch.view0, d / pinch.d0, pinch.cx0);
      view = clampView({ ...zoomed, scrollX: zoomed.scrollX - (c.x - pinch.cx0) / zoomed.pps, scrollY: zoomed.scrollY - (c.y - pinch.cy0) });
      return;
    }
    const p = press;
    if (!p || e.pointerId !== p.pointer) return;
    if (p.mode === 'slice') {
      moveSlice(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (!p.moved && Math.hypot(dx, dy) > SLOP) {
      p.moved = true;
      window.clearTimeout(holdTimer);
      if (p.mode === 'drag') tileMenu = null;
      if (p.mode === 'none') p.mode = p.target.kind === 'resize' ? 'resize' : 'pan';
    }
    if (!p.moved) return;
    if (p.mode === 'pan') {
      view = clampView({ ...p.view0, scrollX: p.view0.scrollX - dx / p.view0.pps, scrollY: p.view0.scrollY - dy });
    } else if (p.mode === 'drag' && dragging) {
      const s = items.find((x) => x.id === dragging!.id);
      if (!s) return;
      const span = spans[s.id];
      dragging = {
        id: s.id,
        start: Math.max(0, span.start + dx / view.pps),
        y: Math.max(0, s.canvasY + dy),
      };
    } else if (p.mode === 'resize' && p.target.kind === 'resize') {
      const id = p.target.id;
      const s = items.find((x) => x.id === id);
      if (!s) return;
      if (s.kind === 'text') {
        // A note's corner: its box, in pixels.
        const box = noteBox0 ?? { w: NOTE_W, h: 40 };
        resizingNote = { id, w: Math.max(60, Math.round(box.w + dx)), h: Math.max(28, Math.round(box.h + dy)) };
        return;
      }
      const span = spans[id];
      // Relative to where the drag began, so grabbing the grip a little inside the edge changes nothing.
      const end = span.end + dx / view.pps;
      const pattern = patternOf(s);
      if (pattern) {
        // A rhythm: whole bars (its pattern repeats, the last repeat cut short).
        const bars = Math.round((end - span.start) / barSeconds(pattern));
        resizing = { id, count: Math.min(MAX_LENGTH_BARS, Math.max(1, bars)) };
      } else {
        // A recording: whole repeats of its playing part.
        const repeats = Math.round((end - span.start) / Math.max(0.05, span.cycle));
        resizing = { id, count: Math.min(MAX_CANVAS_REPEATS, Math.max(1, repeats)) };
      }
    }
  }

  function up(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) interacting = false;
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    const p = press;
    if (!p || e.pointerId !== p.pointer) return;
    press = null;
    window.clearTimeout(holdTimer);
    if (p.mode === 'slice') return;
    if (p.mode === 'drag' && dragging) {
      const d = dragging;
      dragging = null;
      if (p.moved) {
        const span = spans[d.id];
        // The sketch's playing part starts where it was dropped; its recording starts that much earlier.
        void app.placeSketch(d.id, (d.start - span.from) * 1000, Math.round(d.y));
      } else {
        openTileMenu(d.id, p.x0, p.y0);
      }
      return;
    }
    if (p.mode === 'resize') {
      const r = resizing;
      resizing = null;
      if (r) void stretch(r.id, r.count);
      const n = resizingNote;
      resizingNote = null;
      if (n) void app.updateTextNote({ id: n.id, canvasW: n.w, canvasH: n.h });
      return;
    }
    if (p.moved || p.held || p.dismiss) return;
    // A tap.
    if (p.target.kind === 'empty') {
      const at = localPoint(e.clientX, e.clientY);
      const now = performance.now();
      const last = lastEmptyTap;
      if (last && now - last.at < DOUBLE_TAP_MS + 60 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
        // A double tap: a note there (and the playhead back where the first tap took it from).
        lastEmptyTap = null;
        if (!playing) engine.seek(last.before);
        draftNote = { at: Math.max(0, at.time), canvasY: Math.max(0, Math.round(at.canvasY - 16)) };
        return;
      }
      lastEmptyTap = { x: e.clientX, y: e.clientY, at: now, before: solo ? solo.resume : currentTime };
      seekTo(at.time);
    } else {
      // Inside the tap, so the sound can start (WebKit), even though it plays a moment later.
      wakeAudio();
      tapTile(p.target.id);
    }
  }

  function cancel(e: PointerEvent) {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) interacting = false;
    pinch = null;
    press = null;
    dragging = null;
    resizing = null;
    resizingNote = null;
    window.clearTimeout(holdTimer);
  }

  function tapTile(id: string) {
    const now = performance.now();
    if (lastTap && lastTap.id === id && now - lastTap.at < DOUBLE_TAP_MS) {
      window.clearTimeout(lastTap.timer);
      lastTap = null;
      openSketch(id);
      return;
    }
    if (lastTap) window.clearTimeout(lastTap.timer);
    const timer = window.setTimeout(() => {
      lastTap = null;
      playAlone(id);
    }, DOUBLE_TAP_MS);
    lastTap = { id, at: now, timer };
  }

  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (recordingHere) return;
    // Touch long presses are handled by the hold timer.
    if (lastPointerType !== 'mouse') return;
    const target = targetOf(e.target);
    const at = localPoint(e.clientX, e.clientY);
    if (target.kind === 'empty') openCreateMenu(e.clientX, e.clientY, at.time, at.canvasY);
    else openTileMenu(target.id, e.clientX, e.clientY);
  }

  function wheel(node: HTMLElement) {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cw : 1;
      if (e.ctrlKey || e.metaKey) {
        const at = localPoint(e.clientX, e.clientY);
        view = zoomAround(view, Math.exp(-e.deltaY * unit * 0.01), at.x);
        return;
      }
      const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
      const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
      view = clampView({ ...view, scrollX: view.scrollX + dx / view.pps, scrollY: view.scrollY + dy });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onWheel) };
  }

  // ------------------------------------------------------------ menus

  /** The long-press menu: where it is on screen, and the point it creates at. */
  let createMenu = $state<{ x: number; y: number; at: number; canvasY: number } | null>(null);
  let tileMenu = $state<{ id: string; x: number; y: number } | null>(null);

  function openCreateMenu(x: number, y: number, at: number, canvasY: number) {
    // The new sketch's top sits a little above the finger.
    createMenu = { x, y, at: Math.max(0, at), canvasY: Math.max(0, Math.round(canvasY - TILE_H / 2)) };
  }

  function openTileMenu(id: string, x: number, y: number) {
    tileMenu = { id, x, y };
  }

  /** Keep a popover of `w`×`h` on screen near (x, y). */
  function placeMenu(x: number, y: number, w: number, h: number) {
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2));
    const above = y - h - 18;
    const top = above > 60 ? above : Math.min(window.innerHeight - h - 8, y + 18);
    return { left, top };
  }

  // ------------------------------------------------------------ making

  let importAt = $state<{ at: number; canvasY: number } | null>(null);
  /** Recording a new rhythm at a point (editing one happens in its own view). */
  let rhythmEditor = $state<{ mode: 'new'; at: number; canvasY: number } | null>(null);

  /** The rhythm under a point of the timeline (nearest vertically), to count in at its tempo. */
  function rhythmAt(time: number, y: number): { span: Span; pattern: RhythmPattern } | null {
    let best: { span: Span; pattern: RhythmPattern; d: number } | null = null;
    for (const s of sketches) {
      const pattern = patternOf(s);
      const span = spans[s.id];
      if (!pattern || time < span.start - 0.05 || time >= span.end) continue;
      const d = Math.abs(s.canvasY - y);
      if (!best || d < best.d) best = { span, pattern, d };
    }
    return best;
  }

  function recordAudio(at: number, canvasY: number) {
    createMenu = null;
    if (!notebook) return;
    if (!app.canRecord) {
      app.toast('Recording is not available on this device.', 'error');
      return;
    }
    wakeAudio();
    if (solo) endSolo(false);
    engine.pause();
    // Over a rhythm: count in at its tempo and start on its nearest beat.
    const under = rhythmAt(at, canvasY);
    let from = at;
    let tempo: { bpm: number; beat: number } | undefined;
    if (under) {
      tempo = { bpm: under.pattern.bpm, beat: under.span.start };
      from = Math.max(under.span.start, nearestBeat(at, under.pattern.bpm, under.span.start));
    }
    recordingAt = from;
    applyRange();
    engine.setDuration(Math.max(itemsEnd, from + 3600));
    void app.startRecording({
      canvas: {
        notebookId: notebook.id,
        at: from,
        y: canvasY,
        tempo,
        onDownbeat: () => {
          engine.seek(from);
          engine.play();
          // What is heard at this instant: the start sounds after the engine's lead and the output latency.
          return engine.heardPosition();
        },
        onEnd: () => {
          engine.pause();
          recordingAt = null;
          applyRange();
          engine.seek(from);
          // The recorder had the audio session: start the canvas's sound afresh on the next tap.
          audioStale = true;
        },
      },
    });
  }

  function startImport(at: number, canvasY: number) {
    createMenu = null;
    importAt = { at, canvasY };
  }

  function startRhythm(at: number, canvasY: number) {
    createMenu = null;
    wakeAudio();
    if (solo) endSolo(false);
    engine.pause();
    rhythmEditor = { mode: 'new', at, canvasY };
  }

  async function importFile(kind: 'midi' | 'audio', file: File): Promise<boolean> {
    if (!notebook || !importAt) return false;
    engine.pause();
    return app.importSketch(kind, file, {
      notebookId: notebook.id,
      canvasXMs: Math.round(importAt.at * 1000),
      canvasY: importAt.canvasY,
    });
  }

  async function saveRhythm(pattern: RhythmPattern, title: string) {
    const editor = rhythmEditor;
    if (!editor || !notebook) return;
    const saved = await app.createRhythm({
      notebookId: notebook.id,
      canvasXMs: Math.round(editor.at * 1000),
      canvasY: editor.canvasY,
      title,
      rhythm: pattern,
      durationMs: Math.round(playSeconds(pattern) * 1000),
    });
    if (saved) rhythmEditor = null;
  }

  /** A sketch stretched by its right edge: a rhythm to `count` bars, a recording to `count` repeats. */
  async function stretch(id: string, count: number) {
    const s = sketches.find((x) => x.id === id);
    if (!s) return;
    const pattern = patternOf(s);
    if (pattern) {
      if (pattern.lengthBars === count) return;
      const next = { ...pattern, lengthBars: count };
      await app.updateRhythm({ id, rhythm: next, durationMs: Math.round(playSeconds(next) * 1000) });
    } else if (s.canvasRepeats !== count) {
      await app.setRepeats(id, count);
    }
  }

  // -------------------------------------------------------------- notes

  async function submitDraft(text: string) {
    const draft = draftNote;
    draftNote = null;
    if (!draft || !notebook || !text.trim()) return;
    await app.createTextNote({ notebookId: notebook.id, canvasXMs: Math.round(draft.at * 1000), canvasY: draft.canvasY, text: text.replace(/\s+$/, '') });
  }

  async function submitNote(id: string, text: string) {
    if (editingNote === id) editingNote = null;
    const note = textNotes.find((n) => n.id === id);
    if (!note) return;
    if (!text.trim()) await app.removeTextNote(id);
    else if (text !== note.textNotes) await app.updateTextNote({ id, text: text.replace(/\s+$/, '') });
  }

  /** A note's first line, without markdown, for its menu. */
  function noteTitle(text: string): string {
    const line = text.split('\n').find((l) => l.trim()) ?? '';
    return line.replace(/[#>*_~`[\]()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Note';
  }

  // -------------------------------------------------------------- slice

  /** Slicing a sketch: where the cut is (timeline seconds), until it is confirmed or cancelled. */
  let slicing = $state<{ id: string; at: number } | null>(null);
  let sliceBarW = $state(280);
  const sliceSketch = $derived(slicing ? (sketches.find((s) => s.id === slicing!.id) ?? null) : null);

  function canSlice(s: Sketch): boolean {
    return s.kind !== 'text' && !!spans[s.id] && sliceRange(spans[s.id], patternOf(s)) !== null;
  }

  /** From the sketch menu: the cut starts where the sketch was held. */
  function startSlice(id: string, clientX: number, clientY: number) {
    tileMenu = null;
    const s = sketches.find((x) => x.id === id);
    if (!s) return;
    const at = snapSlice(spans[id], patternOf(s), localPoint(clientX, clientY).time);
    if (at === null) return;
    if (solo) endSolo();
    slicing = { id, at };
  }

  function moveSlice(clientX: number, clientY: number) {
    const s = sliceSketch;
    if (!slicing || !s) return;
    const at = snapSlice(spans[s.id], patternOf(s), localPoint(clientX, clientY).time);
    if (at !== null) slicing = { id: s.id, at };
  }

  async function confirmSlice() {
    const cut = slicing;
    const s = sliceSketch;
    slicing = null;
    if (!cut || !s) return;
    const span = spans[s.id];
    const pattern = patternOf(s);
    const secondTitle = `${titleOf(s)} (2)`.slice(0, 120);
    if (pattern) {
      const bars = Math.round((cut.at - span.start) / barSeconds(pattern));
      const [first, second] = sliceRhythm(pattern, bars);
      await app.sliceSketch(s.id, {
        kind: 'rhythm',
        first,
        second,
        firstMs: Math.round(playSeconds(first) * 1000),
        secondMs: Math.round(playSeconds(second) * 1000),
        secondXMs: Math.round((span.start + first.lengthBars * barSeconds(pattern)) * 1000),
        secondTitle,
      });
    } else {
      const crops = sliceCrops({ startMs: s.cropStartMs, endMs: s.cropEndMs }, span, cut.at);
      await app.sliceSketch(s.id, { kind: 'audio', ...crops, secondTitle });
    }
  }

  // ------------------------------------------- copy, duplicate, export

  function copy(id: string) {
    tileMenu = null;
    app.copySketch(id);
  }

  /** A copy right after the original, at the same height. */
  async function duplicate(id: string) {
    tileMenu = null;
    const s = items.find((x) => x.id === id);
    if (!s || !notebook) return;
    if (s.kind === 'text') {
      // A note's copy goes just below it.
      const el = canvasEl.querySelector<HTMLElement>(`[data-tile="${id}"]`);
      const height = el ? el.offsetHeight : 48;
      await app.duplicateSketch(id, { notebookId: notebook.id, canvasXMs: s.canvasXMs, canvasY: Math.round(s.canvasY + height + 12) });
      return;
    }
    const span = spans[id];
    // Its playing part starts where the original's ends (repeats included).
    await app.duplicateSketch(id, { notebookId: notebook.id, canvasXMs: (span.end - span.from) * 1000, canvasY: s.canvasY });
  }

  /** The copied sketch, its playing part starting where the canvas was held. */
  async function paste(at: number, canvasY: number) {
    createMenu = null;
    const source = app.copied;
    if (!source || !notebook) return;
    const from = sketchSpan(source).from;
    await app.duplicateSketch(source.id, { notebookId: notebook.id, canvasXMs: (at - from) * 1000, canvasY });
  }

  function exportSketch(id: string) {
    tileMenu = null;
    app.shareSketches([id]);
  }

  function openSketch(id: string) {
    const s = items.find((x) => x.id === id);
    if (!s) return;
    tileMenu = null;
    if (s.kind === 'text') {
      editingNote = id;
      return;
    }
    // A recording opens in the sketch view, a rhythm in the rhythm view.
    app.openSketch(id);
  }

  // -------------------------------------------------- rename and delete

  let renaming = $state<{ kind: 'sketch' | 'notebook'; id: string; value: string } | null>(null);
  let confirming = $state<{ kind: 'sketch' | 'notebook'; id: string } | null>(null);

  async function commitRename() {
    const r = renaming;
    renaming = null;
    if (!r) return;
    if (r.kind === 'sketch') {
      try {
        await app.rename(r.id, r.value);
      } catch (error) {
        app.toast(`Could not rename: ${errorMessage(error)}`, 'error');
      }
    } else {
      await app.renameNotebook(r.id, r.value);
    }
  }

  /**
   * From the sketch menu. The id is read before the menu closes: closing it
   * empties the menu's `{@const}` sketch, so reading it afterwards threw and
   * the confirmation never opened.
   */
  function askDelete(id: string) {
    tileMenu = null;
    confirming = { kind: 'sketch', id };
  }

  async function confirmDelete() {
    const c = confirming;
    confirming = null;
    if (!c) return;
    if (c.kind === 'sketch') {
      if (solo?.id === c.id) endSolo();
      try {
        await app.deleteSketch(c.id);
      } catch (error) {
        app.toast(`Could not delete: ${errorMessage(error)}`, 'error');
      }
    } else {
      await app.deleteNotebook(c.id);
    }
  }

  // ---------------------------------------------------------- notebooks

  let showNotebooks = $state(false);
  let showSettings = $state(false);

  function chooseNotebook(id: string) {
    showNotebooks = false;
    app.selectNotebook(id);
  }

  async function newNotebook() {
    showNotebooks = false;
    await app.createNotebook();
  }

  // -------------------------------------------------------------- loop

  function toggleRepeat() {
    repeat = !repeat;
  }

  function onLoopChange(start: number, end: number, done: boolean) {
    loopDraft = { start, end };
    if (done && notebook) {
      loopDraft = null;
      void app.setNotebookLoop(notebook.id, Math.round(start * 1000), Math.round(end * 1000));
    }
  }

  /** A loop edge being dragged on the ruler. */
  let rulerDrag: { edge: 'start' | 'end'; pointer: number } | null = null;
  const MIN_LOOP = 0.25;
  const LOOP_EDGES = ['start', 'end'] as const;

  function rulerHandleDown(e: PointerEvent, edge: 'start' | 'end') {
    // The ruler is part of the canvas: this press is not a canvas gesture.
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    rulerDrag = { edge, pointer: e.pointerId };
  }

  function rulerHandleMove(e: PointerEvent) {
    const d = rulerDrag;
    if (!d || d.pointer !== e.pointerId || !loopRange) return;
    const t = Math.max(0, localPoint(e.clientX, e.clientY).time);
    if (d.edge === 'start') onLoopChange(Math.min(t, loopRange.end - MIN_LOOP), loopRange.end, false);
    else onLoopChange(loopRange.start, Math.max(t, loopRange.start + MIN_LOOP), false);
  }

  function rulerHandleUp(e: PointerEvent) {
    const d = rulerDrag;
    if (!d || d.pointer !== e.pointerId) return;
    rulerDrag = null;
    if (loopRange) onLoopChange(loopRange.start, loopRange.end, true);
  }

  function resetLoop() {
    if (notebook) void app.setNotebookLoop(notebook.id, null, null);
  }

  function navigateTo(time: number, y: number) {
    view = clampView({ ...view, scrollX: time - cw / 2 / view.pps, scrollY: y - (ch - RULER_H) / 2 });
  }

  // ------------------------------------------------------------- misc

  function titleOf(s: Sketch): string {
    if (s.kind === 'text') return noteTitle(s.textNotes);
    if (s.kind === 'rhythm') return s.title.trim() || 'Rhythm';
    return displayTitle(s);
  }

  function noteOf(s: Sketch): string | null {
    if (s.kind !== 'audio') return null;
    if (decoding[s.id]?.state === 'failed') return 'cannot play here';
    if (app.jobs[s.id] || s.transcriptionStatus === 'running' || s.transcriptionStatus === 'pending') return 'transcribing…';
    return null;
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea') || rhythmEditor || editingNote || draftNote) return;
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      if (recordingHere) void app.stopRecording();
      else togglePlay();
    } else if (e.key === 'Escape') {
      slicing = null;
      closeMenus();
      if (solo) endSolo();
    }
  }

  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const onTheme = () => theme++;
  /** Back from the background (iOS suspends audio there): a fresh context on the next tap. */
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      engine.pause();
      audioStale = true;
    }
  };
  onMount(() => {
    media?.addEventListener?.('change', onTheme);
    document.addEventListener('visibilitychange', onVisibility);
  });

  onDestroy(() => {
    disposed = true;
    media?.removeEventListener?.('change', onTheme);
    document.removeEventListener('visibilitychange', onVisibility);
    window.clearTimeout(watchdog);
    window.clearTimeout(holdTimer);
    if (lastTap) window.clearTimeout(lastTap.timer);
    if (notebook && viewFor === notebook.id) savedViews.set(notebook.id, { view, repeat });
    engine.dispose();
  });

  const tileMenuSketch = $derived(tileMenu ? (items.find((s) => s.id === tileMenu!.id) ?? null) : null);
  const createSpot = $derived(createMenu ?? (importAt ? { at: importAt.at, canvasY: importAt.canvasY } : rhythmEditor));
</script>

<svelte:window onkeydown={onKey} onpointerdowncapture={onWindowDown} />

<div class="notebook">
  <header class="bar">
    <div class="picker">
      <button
        class="title serif"
        onclick={() => (showNotebooks = !showNotebooks)}
        aria-haspopup="menu"
        aria-expanded={showNotebooks}
        aria-label="Notebook: {notebook?.title || 'Untitled'}. Other notebooks"
      >
        <span class="name">{notebook?.title || 'Untitled notebook'}</span>
        <Icon name="down" size={18} />
      </button>
      {#if showNotebooks}
        <div class="dropdown" role="menu">
          <div class="menu-label">Notebooks</div>
          {#each [...app.notebooks].reverse() as n (n.id)}
            <button role="menuitemradio" aria-checked={n.id === notebook?.id} onclick={() => chooseNotebook(n.id)}>
              <span class="check">{#if n.id === notebook?.id}<Icon name="check" size={16} />{/if}</span>
              <span class="nb-name">{n.title || 'Untitled notebook'}</span>
              <span class="dim tabular">{app.sketches.filter((s) => s.notebookId === n.id && s.parentId === null).length}</span>
            </button>
          {/each}
          <div class="menu-sep"></div>
          <button role="menuitem" onclick={newNotebook}><Icon name="plus" size={18} /> New notebook</button>
          {#if notebook}
            <button
              role="menuitem"
              onclick={() => {
                showNotebooks = false;
                renaming = { kind: 'notebook', id: notebook!.id, value: notebook!.title };
              }}><Icon name="edit" size={18} /> Rename this notebook</button
            >
            <button
              role="menuitem"
              class="danger"
              onclick={() => {
                showNotebooks = false;
                confirming = { kind: 'notebook', id: notebook!.id };
              }}><Icon name="trash" size={18} /> Delete this notebook</button
            >
          {/if}
        </div>
      {/if}
    </div>
    <span class="spacer"></span>
    <button class="icon-button" onclick={() => app.openReference()} aria-label="Reference: chords and the circle of fifths" title="Reference">
      <Icon name="book" />
    </button>
    <button class="icon-button" onclick={() => (showSettings = true)} aria-label="Settings">
      <Icon name="settings" />
    </button>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="canvas"
    bind:this={canvasEl}
    bind:clientWidth={cw}
    bind:clientHeight={ch}
    use:wheel
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
    oncontextmenu={onContextMenu}
    style:background-position="{-viewLeft % 24}px {(-view.scrollY + RULER_H) % 24}px"
  >
    <div class="world" style:transform="translate({-viewLeft}px, {-view.scrollY}px)">
      {#each sketches as s (s.id)}
        {@const span = spans[s.id]}
        {@const pattern = patternOf(s)}
        {@const stretching = resizing?.id === s.id ? resizing.count : null}
        {@const stretched = stretching !== null && pattern ? { ...pattern, lengthBars: stretching } : pattern}
        {@const shown =
          stretching === null
            ? span
            : pattern
              ? sketchSpan({ ...s, rhythm: stretched })
              : sketchSpan({ ...s, canvasRepeats: stretching }, s.kind === 'audio' ? lengths[s.id] : undefined)}
        {@const moving = dragging?.id === s.id ? dragging : null}
        <CanvasTile
          sketch={s}
          span={shown}
          title={titleOf(s)}
          pps={view.pps}
          left={(moving ? moving.start : shown.start) * view.pps}
          top={moving ? moving.y : s.canvasY}
          peaks={peaks[s.id] ?? null}
          peakRate={PEAK_RATE}
          notes={previewNotes[s.id] ?? []}
          pattern={stretched}
          viewLeft={viewLeft}
          viewRight={viewLeft + cw}
          volume={s.canvasVolume ?? 1}
          soloing={solo?.id === s.id}
          progress={solo?.id === s.id ? currentTime : null}
          lifted={!!moving}
          badge={stretching === null ? null : pattern ? `${stretching} bar${stretching === 1 ? '' : 's'}` : `×${stretching}`}
          note={noteOf(s)}
          {theme}
        />
      {/each}
      {#each textNotes as n (n.id)}
        {@const moving = dragging?.id === n.id ? dragging : null}
        {@const size = resizingNote?.id === n.id ? resizingNote : null}
        <CanvasNote
          id={n.id}
          text={n.textNotes}
          width={size ? size.w : n.canvasW}
          height={size ? size.h : n.canvasH}
          left={(moving ? moving.start : spans[n.id].start) * view.pps}
          top={moving ? moving.y : n.canvasY}
          editing={editingNote === n.id}
          lifted={!!moving}
          onsubmit={(text) => submitNote(n.id, text)}
        />
      {/each}
      {#if recordingHere && app.recording && recordingAt !== null}
        <RecordingStrip
          recording={app.recording}
          left={recordingAt * view.pps}
          top={app.recording.canvas?.y ?? 0}
          pps={view.pps}
          played={Math.max(0, currentTime - recordingAt)}
          {viewLeft}
          viewRight={viewLeft + cw}
          {theme}
        />
      {/if}
      {#if draftNote}
        <CanvasNote
          id={null}
          text=""
          width={null}
          height={null}
          left={draftNote.at * view.pps}
          top={draftNote.canvasY}
          editing
          onsubmit={submitDraft}
        />
      {/if}
    </div>

    {#if createSpot}
      <!-- Where the new sketch goes. -->
      <div
        class="spot"
        style:left="{(createSpot.at - view.scrollX) * view.pps}px"
        style:top="{createSpot.canvasY - view.scrollY + RULER_H}px"
        style:height="{TILE_H}px"
      ></div>
    {/if}

    {#if repeat && loopRange}
      <!-- What repeats: its edges, down the whole canvas. -->
      {#each [loopRange.start, loopRange.end] as edge, i (i)}
        {@const x = (edge - view.scrollX) * view.pps}
        {#if x > -2 && x < cw + 2}
          <div class="loop-edge" data-loop-edge={i === 0 ? 'start' : 'end'} style:left="{x}px" style:top="{RULER_H}px"></div>
        {/if}
      {/each}
    {/if}

    {#if slicing && sliceSketch}
      {@const x = (slicing.at - view.scrollX) * view.pps}
      {@const top = sliceSketch.canvasY - view.scrollY + RULER_H}
      {@const barTop = top - 60 > RULER_H + 4 ? top - 60 : top + TILE_H + 14}
      <div class="slice-line" style:left="{x}px" style:top="{top - 8}px" style:height="{TILE_H + 16}px" aria-hidden="true">
        <span class="slice-knob"></span>
      </div>
      <div
        class="slice-bar"
        role="toolbar"
        tabindex="-1"
        aria-label="Slice {titleOf(sliceSketch)}"
        bind:clientWidth={sliceBarW}
        style:left="{Math.max(8, Math.min(x - sliceBarW / 2, cw - sliceBarW - 8))}px"
        style:top="{barTop}px"
        onpointerdown={(e) => e.stopPropagation()}
      >
        <span class="slice-at tabular">Cut at {formatClockTenths(slicing.at - spans[sliceSketch.id].start)}</span>
        <button class="pill-button" onclick={() => (slicing = null)}>Cancel</button>
        <button class="pill-button primary" onclick={confirmSlice}><Icon name="slice" size={16} /> Slice</button>
      </div>
    {/if}

    <div class="ruler" style:height="{RULER_H}px">
      {#if repeat && loopRange}
        <div
          class="ruler-loop"
          style:left="{(loopRange.start - view.scrollX) * view.pps}px"
          style:width="{(loopRange.end - loopRange.start) * view.pps}px"
        ></div>
      {/if}
      {#each ticks as tick (tick.t)}
        <span class="tick tabular" style:left="{tick.x}px">{tick.label}</span>
      {/each}
      {#if repeat && loopRange}
        <!-- The loop's edges, dragged along the ruler (as on the minimap). -->
        {#each LOOP_EDGES as edge (edge)}
          {@const x = ((edge === 'start' ? loopRange.start : loopRange.end) - view.scrollX) * view.pps}
          {#if x > -20 && x < cw + 20}
            <div
              class="ruler-handle {edge}"
              style:left="{x}px"
              role="slider"
              tabindex="-1"
              aria-label="Loop {edge}"
              aria-valuenow={Math.round((edge === 'start' ? loopRange.start : loopRange.end) * 10) / 10}
              onpointerdown={(e) => rulerHandleDown(e, edge)}
              onpointermove={rulerHandleMove}
              onpointerup={rulerHandleUp}
              onpointercancel={rulerHandleUp}
            >
              <span></span>
            </div>
          {/if}
        {/each}
      {/if}
    </div>

    {#if playheadX > -2 && playheadX < cw + 2}
      <div class="playhead" class:parked={!!solo} style:left="{playheadX}px"></div>
    {/if}

    {#if app.ready && items.length === 0 && !createSpot && !draftNote && !recordingHere}
      <div class="empty">
        <p class="serif lead">An empty page.</p>
        <p>Press and hold anywhere to record, import or tap out a rhythm; double-tap to write a note. Left to right is time.</p>
      </div>
    {/if}
  </div>

  <footer class="dock">
    <Minimap
      items={sketches.map((s) => ({ id: s.id, start: spans[s.id].start, end: spans[s.id].end, y: s.canvasY, rhythm: s.kind === 'rhythm' }))}
      notes={textNotes.map((n) => ({
        id: n.id,
        start: spans[n.id].start,
        width: (n.canvasW ?? NOTE_W) / view.pps,
        y: n.canvasY,
        height: n.canvasH ?? 40,
        emoji: isEmojiOnly(n.textNotes) ? n.textNotes.replace(/\s+/g, '') : null,
      }))}
      {view}
      viewWidth={cw}
      viewHeight={Math.max(0, ch - RULER_H)}
      playhead={playheadTime}
      loop={repeat ? loopRange : null}
      onnavigate={navigateTo}
      onloopchange={onLoopChange}
      {theme}
    />
    <div class="controls">
      {#if recordingHere}
        <button class="play stop" onclick={() => app.stopRecording()} disabled={app.recording?.phase !== 'recording'} aria-label="Stop recording">
          <span class="square" aria-hidden="true"></span>
        </button>
      {:else}
        <button class="play" onclick={togglePlay} disabled={sketches.length === 0} aria-label={playing && !solo ? 'Pause' : 'Play'}>
          <Icon name={playing && !solo ? 'pause' : 'play'} size={22} />
        </button>
      {/if}
      <span class="time tabular"
        >{formatClockTenths(playheadTime)}{#if buffering}<span class="dim"> loading…</span>{/if}</span
      >
      <span class="spacer"></span>
      {#if repeat && customLoop}
        <button class="link" onclick={resetLoop}>Loop everything</button>
      {/if}
      <button
        class="icon-button toggle"
        class:on={repeat}
        onclick={toggleRepeat}
        aria-pressed={repeat}
        aria-label="Repeat"
        title="Repeat"
        disabled={!loopRange && !repeat}
      >
        <Icon name="loop" size={20} />
      </button>
      <button class="icon-button" onclick={fit} aria-label="Show the whole notebook" title="Show the whole notebook">
        <Icon name="fit" size={20} />
      </button>
    </div>
  </footer>
</div>

{#if createMenu}
  {@const m = createMenu}
  {@const copied = app.copied}
  {@const at = placeMenu(m.x, m.y, 232, copied ? 222 : 168)}
  <div class="popover" role="menu" style:left="{at.left}px" style:top="{at.top}px" aria-label="New sketch at {formatClock(m.at)}">
    <div class="menu-label tabular">New sketch at {formatClockTenths(m.at)}</div>
    <button role="menuitem" onclick={() => recordAudio(m.at, m.canvasY)}><span class="rec-dot" aria-hidden="true"></span> Record audio</button>
    <button role="menuitem" onclick={() => startImport(m.at, m.canvasY)}><Icon name="import" size={18} /> Import audio</button>
    <button role="menuitem" onclick={() => startRhythm(m.at, m.canvasY)}><Icon name="pads" size={18} /> Record rhythm</button>
    {#if copied}
      <div class="menu-sep"></div>
      <button role="menuitem" onclick={() => paste(m.at, m.canvasY)}>
        <Icon name="paste" size={18} /> <span class="nb-name">Paste “{titleOf(copied)}”</span>
      </button>
    {/if}
  </div>
{/if}

{#if tileMenu && tileMenuSketch}
  {@const m = tileMenu}
  {@const s = tileMenuSketch}
  {@const sounds = s.kind !== 'text'}
  {@const at = placeMenu(m.x, m.y, 232, sounds ? 362 : 212)}
  {@const volume = Math.round((s.canvasVolume ?? 1) * 100)}
  <div class="popover" role="menu" style:left="{at.left}px" style:top="{at.top}px" aria-label={titleOf(s)}>
    <div class="menu-label">{titleOf(s)}</div>
    {#if sounds}
      <label class="volume-row">
        <Icon name="volume" size={18} />
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          oninput={(e) => app.setVolume(s.id, Number(e.currentTarget.value) / 100)}
          aria-label="Volume of {titleOf(s)}"
        />
        <span class="tabular vol-value">{volume}%</span>
      </label>
      <div class="menu-sep"></div>
    {/if}
    {#if s.kind === 'text'}
      <button role="menuitem" onclick={() => openSketch(s.id)}><Icon name="edit" size={18} /> Edit</button>
    {/if}
    <button role="menuitem" onclick={() => copy(s.id)}><Icon name="copy" size={18} /> Copy</button>
    <button role="menuitem" onclick={() => duplicate(s.id)}><Icon name="duplicate" size={18} /> Duplicate</button>
    {#if s.kind !== 'text'}
      <button role="menuitem" onclick={() => startSlice(s.id, m.x, m.y)} disabled={!canSlice(s)}><Icon name="slice" size={18} /> Slice</button>
      <button role="menuitem" onclick={() => exportSketch(s.id)}><Icon name="share" size={18} /> Export</button>
    {/if}
    <button role="menuitem" class="danger" onclick={() => askDelete(s.id)}><Icon name="trash" size={18} /> Delete</button>
  </div>
{/if}

{#if importAt}
  <ImportSheet onimport={importFile} onclose={() => (importAt = null)} />
{/if}

{#if rhythmEditor}
  <RhythmModal
    context={() => engine.context}
    destination={() => engine.input}
    unlock={() => engine.unlock()}
    initial={null}
    onsave={saveRhythm}
    onclose={() => (rhythmEditor = null)}
  />
{/if}

{#if renaming}
  <Sheet title={renaming.kind === 'notebook' ? 'Rename notebook' : 'Rename sketch'} onclose={() => (renaming = null)}>
    <form
      class="rename"
      onsubmit={(e) => {
        e.preventDefault();
        void commitRename();
      }}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input bind:value={renaming.value} maxlength="120" autofocus aria-label="Name" />
      <div class="confirm-actions">
        <button class="pill-button primary" type="submit">Save</button>
        <button class="pill-button" type="button" onclick={() => (renaming = null)}>Cancel</button>
      </div>
    </form>
  </Sheet>
{/if}

{#if confirming}
  {@const c = confirming}
  {@const count = app.sketches.filter((s) => s.notebookId === c.id && s.parentId === null).length}
  {@const isNote = c.kind === 'sketch' && textNotes.some((n) => n.id === c.id)}
  <Sheet title={c.kind === 'notebook' ? 'Delete this notebook?' : isNote ? 'Delete this note?' : 'Delete this sketch?'} onclose={() => (confirming = null)}>
    <p class="confirm-text">
      {#if c.kind === 'notebook'}
        {count === 0 ? 'It is empty.' : `Its ${count === 1 ? 'sketch' : `${count} sketches`}, with recordings, transcriptions and notes, will be permanently removed from this device.`}
      {:else if isNote}
        The note will be removed from the notebook.
      {:else}
        The sketch, its recording, its transcription and your notes will be permanently removed from this device.
      {/if}
    </p>
    <div class="confirm-actions">
      <button class="pill-button danger" onclick={confirmDelete}>Delete</button>
      <button class="pill-button" onclick={() => (confirming = null)}>Cancel</button>
    </div>
  </Sheet>
{/if}

{#if showSettings}
  <SettingsSheet onclose={() => (showSettings = false)} />
{/if}

<style>
  .notebook {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .bar {
    position: relative;
    z-index: 6;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: calc(var(--safe-top) + 8px) calc(var(--safe-right) + 8px) 8px calc(var(--safe-left) + 12px);
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
  }
  .picker {
    position: relative;
    min-width: 0;
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 1.45rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .title:hover {
    background: var(--paper-sunk);
  }
  .title .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title :global(svg) {
    flex: none;
    color: var(--ink-3);
  }
  .spacer {
    flex: 1;
  }
  .dropdown,
  .popover {
    display: grid;
    padding: 6px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    box-shadow: var(--shadow);
  }
  .dropdown {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    z-index: 20;
    width: min(300px, calc(100vw - 24px));
    max-height: 60vh;
    overflow-y: auto;
  }
  .popover {
    position: fixed;
    z-index: 30;
    width: 232px;
    animation: pop 120ms ease;
  }
  @keyframes pop {
    from {
      opacity: 0;
      scale: 0.96;
    }
  }
  .dropdown button,
  .popover button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border-radius: var(--radius-sm);
    text-align: left;
    font-size: 0.95rem;
  }
  .dropdown button:hover,
  .popover button:hover {
    background: var(--paper-sunk);
  }
  .danger {
    color: var(--accent);
  }
  .menu-label {
    padding: 4px 10px 4px;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .volume-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px 8px;
    color: var(--ink-2);
  }
  .volume-row input {
    flex: 1;
    min-width: 0;
    accent-color: var(--ink-2);
    touch-action: pan-x;
  }
  .vol-value {
    width: 3.2em;
    text-align: right;
    font-size: 0.85rem;
    color: var(--ink-2);
  }
  .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--rule);
  }
  .check {
    width: 16px;
    display: inline-grid;
    color: var(--accent);
  }
  .nb-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: var(--ink-3);
    font-size: 0.8rem;
  }
  .rec-dot {
    width: 12px;
    height: 12px;
    margin: 0 3px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }

  .canvas {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    background-color: var(--paper);
    background-image: radial-gradient(circle, var(--rule) 1px, transparent 1.2px);
    background-size: 24px 24px;
    cursor: default;
  }
  .world {
    position: absolute;
    left: 0;
    top: 0;
    will-change: transform;
  }
  .ruler {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    z-index: 4;
    background: color-mix(in srgb, var(--paper) 92%, transparent);
    border-bottom: 1px solid var(--rule);
    overflow: hidden;
  }
  .ruler-loop {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--accent-soft);
    border-left: 2px solid var(--accent);
    border-right: 2px solid var(--accent);
  }
  .loop-edge {
    position: absolute;
    bottom: 0;
    z-index: 3;
    width: 0;
    margin-left: -1px;
    border-left: 1.5px dashed var(--accent);
    opacity: 0.5;
    pointer-events: none;
  }
  .ruler-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    width: 28px;
    margin-left: -14px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
    touch-action: none;
  }
  .ruler-handle span {
    width: 6px;
    height: 70%;
    border-radius: 3px;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--paper-raised);
    pointer-events: none;
  }
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    padding: 5px 0 0 4px;
    border-left: 1px solid var(--rule-strong);
    font-size: 0.7rem;
    color: var(--ink-3);
    white-space: nowrap;
  }
  .playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 5;
    width: 2px;
    margin-left: -1px;
    background: var(--accent);
    pointer-events: none;
  }
  .playhead::before {
    content: '';
    position: absolute;
    top: 0;
    left: -5px;
    border: 6px solid transparent;
    border-top: 8px solid var(--accent);
  }
  .playhead.parked {
    opacity: 0.35;
  }
  .spot {
    position: absolute;
    z-index: 2;
    width: 120px;
    border-radius: 10px;
    border: 2px dashed var(--accent);
    background: var(--accent-soft);
    pointer-events: none;
  }
  .slice-line {
    position: absolute;
    z-index: 5;
    width: 2px;
    margin-left: -1px;
    background: var(--accent);
    pointer-events: none;
  }
  .slice-knob {
    position: absolute;
    left: -5px;
    top: -6px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--paper-raised);
  }
  .slice-bar {
    position: absolute;
    z-index: 7;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 6px 6px 12px;
    border-radius: 999px;
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    box-shadow: var(--shadow);
    white-space: nowrap;
  }
  .slice-at {
    font-size: 0.85rem;
    color: var(--ink-2);
    margin-right: 2px;
  }
  .empty {
    position: absolute;
    left: 50%;
    top: 38%;
    transform: translate(-50%, -50%);
    width: min(360px, calc(100% - 40px));
    text-align: center;
    color: var(--ink-2);
    pointer-events: none;
  }
  .lead {
    margin: 0 0 6px;
    font-size: 1.5rem;
    color: var(--ink);
  }

  .dock {
    position: relative;
    z-index: 6;
    display: grid;
    gap: 6px;
    padding: 8px calc(var(--safe-right) + 12px) calc(var(--safe-bottom) + 8px) calc(var(--safe-left) + 12px);
    border-top: 1px solid var(--rule);
    background: var(--paper);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 48px;
  }
  .play {
    width: 46px;
    height: 46px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
    flex: none;
  }
  .play.stop {
    background: var(--accent);
  }
  .play.stop .square {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: var(--accent-ink);
  }
  .time {
    font-size: 1rem;
  }
  .toggle.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .link {
    font-size: 0.85rem;
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .rename {
    display: grid;
    gap: 14px;
  }
  .rename input {
    font-size: 1.05rem;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule-strong);
    background: var(--paper);
  }
  .confirm-text {
    margin: 0 0 16px;
    color: var(--ink-2);
  }
  .confirm-actions {
    display: flex;
    gap: 8px;
  }
</style>
