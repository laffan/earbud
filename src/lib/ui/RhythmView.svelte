<script lang="ts">
  /**
   * A rhythm sketch, full size (opened like a recording, by double-tapping
   * it on the canvas).
   *
   * - The overview shows every bar with all three pads; tap a bar to edit it.
   * - The step grid shows one pad's bar as 16 large steps (a row per beat).
   *   Tap a step to switch it; drag up or down on it to set its velocity,
   *   drawn as how full the step is.
   * - The pads below sound and pick the pad the grid shows. With record on,
   *   pads struck while the loop plays are written on the step they were
   *   meant for.
   * - Tempo (with tap tempo), swing, bars (a new bar copies the last one;
   *   ×2 doubles the pattern), how many bars it plays on the canvas.
   * Edits save themselves; undo and redo are in the bottom bar.
   */
  import { onDestroy, untrack } from 'svelte';
  import { DrumKit } from '../music/drums';
  import {
    doubled,
    emptyPattern,
    MAX_BARS,
    MAX_BPM,
    MAX_LENGTH_BARS,
    MAX_SWING,
    MIN_BPM,
    normalizePattern,
    PADS,
    playSeconds,
    stepsPerBar,
    withBarAdded,
    withBars,
    withCleared,
    withStep,
    type RhythmPattern,
  } from '../music/rhythm';
  import { RhythmPlayer } from '../music/rhythmPlayer';
  import { audioContextClass } from '../playback/audioEngine';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let { id }: { id: string } = $props();

  /** Level of a step switched on by a tap. */
  const NEW_LEVEL = 0.8;
  /** Pixels of vertical drag from silent to full. */
  const DRAG_RANGE = 160;

  const sketch = $derived(app.sketches.find((s) => s.id === id) ?? null);
  let pattern = $state.raw<RhythmPattern>(normalizePattern(untrack(() => sketch?.rhythm)) ?? emptyPattern());
  let title = $state(untrack(() => sketch?.title ?? ''));
  /** The pad the step grid shows, and the bar. */
  let lane = $state(0);
  let page = $state(0);
  let follow = true;

  const perBar = $derived(stepsPerBar(pattern));
  const bars = $derived(Array.from({ length: pattern.bars }, (_, i) => i));

  // ------------------------------------------------------------ editing

  let undoStack: RhythmPattern[] = [];
  let redoStack: RhythmPattern[] = [];
  let canUndo = $state(false);
  let canRedo = $state(false);
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let saveTimer: number | undefined;

  function history() {
    canUndo = undoStack.length > 0;
    canRedo = redoStack.length > 0;
  }

  /** A change, undoable; saved a moment later. */
  function commit(next: RhythmPattern) {
    if (next === pattern) return;
    undoStack = [...undoStack.slice(-99), pattern];
    redoStack = [];
    history();
    pattern = next;
    page = Math.min(page, next.bars - 1);
    scheduleSave();
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(pattern);
    pattern = previous;
    page = Math.min(page, previous.bars - 1);
    history();
    scheduleSave();
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(pattern);
    pattern = next;
    page = Math.min(page, next.bars - 1);
    history();
    scheduleSave();
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveState = 'saving';
    saveTimer = window.setTimeout(() => void save(), 500);
  }

  async function save() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    const saved = await app.updateRhythm({ id, rhythm: pattern, durationMs: Math.round(playSeconds(pattern) * 1000) });
    saveState = saved ? 'saved' : 'error';
  }

  async function saveTitle() {
    if (!sketch || title.trim() === sketch.title.trim()) return;
    try {
      await app.rename(id, title);
    } catch (error) {
      app.toast(`Could not rename: ${errorMessage(error)}`, 'error');
    }
  }

  // --------------------------------------------------------------- sound

  const ctx = new (audioContextClass())({ latencyHint: 'interactive' });
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.ratio.value = 12;
  limiter.connect(ctx.destination);
  const kit = new DrumKit(ctx, limiter);
  const player = new RhythmPlayer(ctx, kit, () => pattern);
  let playing = $state(false);
  let currentStep = $state(-1);
  let armed = $state(false);
  let frame = 0;
  let lit = $state([0, 0, 0]);

  /** Wake the audio inside a tap (WebKit starts it only there). */
  function unlock() {
    if (ctx.state === 'running') return;
    void ctx.resume().catch(() => {});
    try {
      const source = ctx.createBufferSource();
      source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      source.connect(ctx.destination);
      source.start(0);
    } catch {
      // not needed where resume() suffices
    }
  }

  function togglePlay() {
    unlock();
    if (playing) {
      player.stop();
      playing = false;
      cancelAnimationFrame(frame);
      currentStep = -1;
      return;
    }
    playing = true;
    follow = true;
    player.start(0);
    const paint = () => {
      currentStep = player.currentStep();
      if (follow && currentStep >= 0) page = Math.floor(currentStep / perBar);
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
  }

  /** A pad: sound it, show its steps, and with record on while playing, write it on its step. */
  function strike(pad: number) {
    unlock();
    kit.hit(pad);
    lane = pad;
    lit = lit.map((v, i) => (i === pad ? v + 1 : v));
    if (armed && playing) {
      const step = player.nearestStep();
      if (step >= 0 && !(pattern.pads[pad][step] > 0)) commit(withStep(pattern, pad, step, 1));
    }
  }

  // --------------------------------------------------------------- steps

  /** A press on a step: a tap switches it; a vertical drag sets its velocity. */
  let press: { pointer: number; step: number; y0: number; level0: number; moved: boolean } | null = null;
  /** The step whose velocity is being dragged, for the readout. */
  let dragged = $state<number | null>(null);

  function stepDown(e: PointerEvent, step: number) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    press = { pointer: e.pointerId, step, y0: e.clientY, level0: pattern.pads[lane][step] ?? 0, moved: false };
    unlock();
  }

  function stepMove(e: PointerEvent) {
    const p = press;
    if (!p || e.pointerId !== p.pointer) return;
    const dy = e.clientY - p.y0;
    if (!p.moved) {
      if (Math.abs(dy) < 6) return;
      p.moved = true;
      // One undo step for the whole drag.
      undoStack = [...undoStack.slice(-99), pattern];
      redoStack = [];
      history();
      if (p.level0 === 0) p.level0 = NEW_LEVEL;
      dragged = p.step;
    }
    const level = Math.round(Math.min(1, Math.max(0.05, p.level0 - dy / DRAG_RANGE)) * 100) / 100;
    if (level !== pattern.pads[lane][p.step]) pattern = withStep(pattern, lane, p.step, level);
  }

  function stepUp(e: PointerEvent) {
    const p = press;
    if (!p || e.pointerId !== p.pointer) return;
    press = null;
    dragged = null;
    if (p.moved) {
      scheduleSave();
      return;
    }
    const on = (pattern.pads[lane][p.step] ?? 0) > 0;
    commit(withStep(pattern, lane, p.step, on ? 0 : NEW_LEVEL));
    if (!on && !playing) kit.hit(lane, 0, NEW_LEVEL);
  }

  function stepKey(e: KeyboardEvent, step: number) {
    const level = pattern.pads[lane][step] ?? 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.round(Math.min(1, Math.max(0.05, (level || NEW_LEVEL) + (e.key === 'ArrowUp' ? 0.1 : -0.1))) * 100) / 100;
      commit(withStep(pattern, lane, step, next));
    }
  }

  // ------------------------------------------------------------ settings

  function setBpm(bpm: number) {
    if (!Number.isFinite(bpm)) return;
    commit({ ...pattern, bpm: Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) * 10) / 10 });
  }

  let taps: number[] = [];
  /** Tap tempo: the average gap of the last few taps (a pause of 2 s starts again). */
  function tapTempo() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps = [...taps.slice(-5), now];
    if (taps.length >= 3) {
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    }
  }

  let swingDraft = $state<number | null>(null);
  function setSwing(percent: number, done: boolean) {
    const swing = Math.min(MAX_SWING, Math.max(0, percent / 100));
    if (!done) {
      swingDraft = swing;
      pattern = { ...pattern, swing };
      return;
    }
    swingDraft = null;
    scheduleSave();
  }
  let swingBefore: RhythmPattern | null = null;
  function swingStart() {
    swingBefore = pattern;
  }
  function swingEnd() {
    if (swingBefore && swingBefore.swing !== pattern.swing) {
      undoStack = [...undoStack.slice(-99), swingBefore];
      redoStack = [];
      history();
    }
    swingBefore = null;
    setSwing((pattern.swing ?? 0) * 100, true);
  }

  // ---------------------------------------------------------------- menu

  let showMenu = $state(false);
  let confirmDelete = $state(false);

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
      return;
    }
    const pad = PADS.findIndex((p) => p.keys.includes(e.key.toLowerCase()));
    if (pad >= 0) {
      e.preventDefault();
      strike(pad);
    }
  }

  onDestroy(() => {
    player.stop();
    cancelAnimationFrame(frame);
    if (saveTimer !== undefined) void save();
    void saveTitle();
    kit.dispose();
    void ctx.close().catch(() => {});
  });

  const position = $derived.by(() => {
    if (currentStep < 0) return null;
    const bar = Math.floor(currentStep / perBar) + 1;
    const inBar = currentStep % perBar;
    return `${bar}.${Math.floor(inBar / pattern.stepsPerBeat) + 1}.${(inBar % pattern.stepsPerBeat) + 1}`;
  });
  const swingPercent = $derived(Math.round((swingDraft ?? pattern.swing ?? 0) * 100));
</script>

<svelte:window onkeydown={onKey} />

<div class="rhythm-view">
  <header class="bar">
    <button class="icon-button" onclick={() => app.goHome()} aria-label="Back to the notebook"><Icon name="back" /></button>
    <input
      class="title-input serif"
      bind:value={title}
      placeholder="Rhythm"
      aria-label="Title"
      maxlength="120"
      onblur={saveTitle}
      onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
    <button class="icon-button" onclick={() => app.shareSketches([id])} aria-label="Export"><Icon name="share" /></button>
    <div class="menu-anchor">
      <button class="icon-button" onclick={() => (showMenu = !showMenu)} aria-label="More actions" aria-expanded={showMenu}>
        <Icon name="more" />
      </button>
      {#if showMenu}
        <div class="menu" role="menu">
          <button role="menuitem" onclick={() => ((showMenu = false), commit(withCleared(pattern, lane, 0, pattern.pads[lane].length)))}>
            <Icon name="close" size={18} /> Clear {PADS[lane].name.toLowerCase()} in every bar
          </button>
          <button role="menuitem" class="danger" onclick={() => ((showMenu = false), (confirmDelete = true))}>
            <Icon name="trash" size={18} /> Delete rhythm
          </button>
        </div>
      {/if}
    </div>
  </header>

  <main class="content">
    <!-- Every bar, all pads: tap one to edit it. -->
    <section class="overview" aria-label="Bars">
      {#each bars as bar (bar)}
        <button class="bar-block" class:current={bar === page} onclick={() => ((page = bar), (follow = false))} aria-label="Bar {bar + 1}" aria-pressed={bar === page}>
          <span class="bar-number tabular">{bar + 1}</span>
          {#each PADS as _, p (p)}
            <span class="mini-row">
              {#each Array(perBar) as _, i (i)}
                {@const step = bar * perBar + i}
                {@const level = pattern.pads[p][step] ?? 0}
                <span class="mini pad-{p}" class:on={level > 0} class:now={step === currentStep} style:opacity={level > 0 ? 0.35 + 0.65 * level : undefined}></span>
              {/each}
            </span>
          {/each}
        </button>
      {/each}
      <div class="bar-actions">
        <button class="chip-button" onclick={() => commit(withBarAdded(pattern))} disabled={pattern.bars >= MAX_BARS} aria-label="Add a bar (a copy of the last)">
          <Icon name="plus" size={16} /> Bar
        </button>
        <button class="chip-button" onclick={() => commit(doubled(pattern))} disabled={pattern.bars * 2 > MAX_BARS} aria-label="Double the pattern">×2</button>
        <button class="chip-button" onclick={() => commit(withBars(pattern, pattern.bars - 1))} disabled={pattern.bars <= 1} aria-label="Remove the last bar">
          <Icon name="minus" size={16} /> Bar
        </button>
      </div>
    </section>

    <!-- One pad's bar: 16 large steps, a row per beat. -->
    <section class="grid-area" aria-label="{PADS[lane].name} steps, bar {page + 1}">
      <div class="grid-head">
        <span class="lane-name pad-{lane}">{PADS[lane].name}</span>
        <span class="dim">bar {page + 1} of {pattern.bars}</span>
        <span class="spacer"></span>
        {#if dragged !== null}
          <span class="readout tabular">velocity {Math.round((pattern.pads[lane][dragged] ?? 0) * 100)}%</span>
        {:else}
          <span class="dim hint">Tap a step; drag up or down for velocity</span>
        {/if}
      </div>
      <div class="steps pad-{lane}" role="group" onpointermove={stepMove} onpointerup={stepUp} onpointercancel={stepUp}>
        {#each Array(perBar) as _, i (i)}
          {@const step = page * perBar + i}
          {@const level = pattern.pads[lane][step] ?? 0}
          <button
            class="step"
            class:on={level > 0}
            class:now={step === currentStep}
            class:dragging={dragged === step}
            onpointerdown={(e) => stepDown(e, step)}
            onkeydown={(e) => stepKey(e, step)}
            aria-pressed={level > 0}
            aria-label="Beat {Math.floor(i / pattern.stepsPerBeat) + 1}, step {(i % pattern.stepsPerBeat) + 1}{level > 0 ? `, velocity ${Math.round(level * 100)}%` : ''}"
          >
            <span class="fill" style:height="{level * 100}%"></span>
            <span class="num tabular">{Math.floor(i / pattern.stepsPerBeat) + 1}.{(i % pattern.stepsPerBeat) + 1}</span>
            {#if level > 0}<span class="vel tabular">{Math.round(level * 100)}</span>{/if}
          </button>
        {/each}
      </div>
    </section>

    <!-- The pads: sound, pick the pad above, and record into the loop. -->
    <section class="pads" aria-label="Pads">
      {#each PADS as pad, p (pad.name)}
        <button class="pad pad-{p}" class:selected={lane === p} onpointerdown={(e) => (e.preventDefault(), strike(p))} aria-label="{pad.name} (key {pad.keys[0]})">
          {#key lit[p]}<span class="flash" class:go={lit[p] > 0}></span>{/key}
          <span class="pad-name">{pad.name}</span>
          <span class="pad-key">{pad.keys[0]}</span>
        </button>
      {/each}
    </section>

    <section class="settings" aria-label="Tempo and length">
      <div class="setting">
        <span class="label">Tempo</span>
        <div class="stepper">
          <button onclick={() => setBpm(Math.round(pattern.bpm) - 1)} aria-label="Slower"><Icon name="minus" size={16} /></button>
          <span class="value tabular"><span class="note" aria-hidden="true">♩</span>{pattern.bpm % 1 === 0 ? pattern.bpm : pattern.bpm.toFixed(1)}</span>
          <button onclick={() => setBpm(Math.round(pattern.bpm) + 1)} aria-label="Faster"><Icon name="plus" size={16} /></button>
        </div>
        <button class="chip-button" onclick={tapTempo}>Tap</button>
      </div>
      <label class="setting">
        <span class="label">Swing</span>
        <input
          type="range"
          min="0"
          max={MAX_SWING * 100}
          step="1"
          value={swingPercent}
          oninput={(e) => setSwing(Number(e.currentTarget.value), false)}
          onpointerdown={swingStart}
          onchange={swingEnd}
          aria-label="Swing"
        />
        <span class="value tabular">{swingPercent}%</span>
      </label>
      <div class="setting">
        <span class="label">On the canvas</span>
        <div class="stepper">
          <button onclick={() => commit({ ...pattern, lengthBars: Math.max(1, pattern.lengthBars - 1) })} disabled={pattern.lengthBars <= 1} aria-label="Plays a bar less">
            <Icon name="minus" size={16} />
          </button>
          <span class="value tabular">{pattern.lengthBars} bar{pattern.lengthBars === 1 ? '' : 's'}</span>
          <button onclick={() => commit({ ...pattern, lengthBars: Math.min(MAX_LENGTH_BARS, pattern.lengthBars + 1) })} aria-label="Plays a bar more">
            <Icon name="plus" size={16} />
          </button>
        </div>
      </div>
    </section>
  </main>

  <footer class="transport">
    <button class="play" onclick={togglePlay} aria-label={playing ? 'Stop' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={22} /></button>
    <button class="record" class:on={armed} onclick={() => (armed = !armed)} aria-pressed={armed} aria-label="Record pads into the loop" title="Record pads into the loop">
      <span class="dot"></span>
    </button>
    <span class="position tabular">{position ?? `${pattern.bars} bar${pattern.bars === 1 ? '' : 's'}`}</span>
    <span class="spacer"></span>
    <span class="save-state" aria-live="polite">{saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : ''}</span>
    <button class="icon-button" onclick={undo} disabled={!canUndo} aria-label="Undo"><Icon name="undo" /></button>
    <button class="icon-button" onclick={redo} disabled={!canRedo} aria-label="Redo"><Icon name="redo" /></button>
  </footer>
</div>

{#if confirmDelete}
  <Sheet title="Delete this rhythm?" onclose={() => (confirmDelete = false)}>
    <p class="confirm-text">The rhythm will be removed from the notebook.</p>
    <div class="confirm-actions">
      <button class="pill-button danger" onclick={() => ((confirmDelete = false), void app.deleteSketch(id))}>Delete</button>
      <button class="pill-button" onclick={() => (confirmDelete = false)}>Cancel</button>
    </div>
  </Sheet>
{/if}

<style>
  .rhythm-view {
    --kick: var(--ink-2);
    --snare: var(--accent);
    --hat: var(--chord);
    min-height: 100vh;
    min-height: 100dvh;
    padding-bottom: calc(var(--safe-bottom) + 84px);
  }
  .pad-0 {
    --pad: var(--kick);
  }
  .pad-1 {
    --pad: var(--snare);
  }
  .pad-2 {
    --pad: var(--hat);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 6px) 6px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .title-input {
    flex: 1;
    min-width: 0;
    font-size: 1.25rem;
    font-weight: 700;
    border: none;
    background: transparent;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
  }
  .title-input:focus {
    outline: none;
    background: var(--paper-sunk);
  }
  .menu-anchor {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 44px;
    z-index: 20;
    width: min(280px, calc(100vw - 24px));
    display: grid;
    padding: 6px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    box-shadow: var(--shadow);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .menu button:hover {
    background: var(--paper-sunk);
  }
  .danger {
    color: var(--accent);
  }
  .content {
    display: grid;
    gap: 18px;
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: 14px calc(var(--safe-right) + 14px) 0 calc(var(--safe-left) + 14px);
  }

  /* Overview */
  .overview {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: stretch;
  }
  .bar-block {
    position: relative;
    display: grid;
    gap: 3px;
    padding: 18px 7px 7px;
    border-radius: 10px;
    border: 1px solid var(--rule);
    background: var(--paper-raised);
  }
  .bar-block.current {
    border-color: var(--ink);
    box-shadow: 0 0 0 1px var(--ink);
  }
  .bar-number {
    position: absolute;
    left: 7px;
    top: 2px;
    font-size: 0.7rem;
    color: var(--ink-3);
  }
  .mini-row {
    display: flex;
    gap: 1px;
  }
  .mini {
    width: 4px;
    height: 6px;
    border-radius: 1px;
    background: var(--rule);
  }
  .mini:nth-child(4n + 1) {
    margin-left: 2px;
  }
  .mini.on {
    background: var(--pad);
  }
  .mini.now {
    outline: 1.5px solid var(--ink);
  }
  .bar-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    justify-content: center;
  }
  .chip-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 30px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--rule-strong);
    font-size: 0.8rem;
    color: var(--ink-2);
  }

  /* Step grid */
  .grid-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
    min-height: 1.5em;
  }
  .lane-name {
    font-weight: 700;
    color: var(--pad);
  }
  .dim {
    color: var(--ink-3);
    font-size: 0.82rem;
  }
  .hint {
    font-size: 0.75rem;
  }
  .readout {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .spacer {
    flex: 1;
  }
  .steps {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .step {
    position: relative;
    aspect-ratio: 1;
    border-radius: 12px;
    overflow: hidden;
    background: var(--paper-sunk);
    border: 1px solid var(--rule);
    touch-action: none;
    transition: transform 80ms ease;
  }
  /* The first step of each beat a little darker, to read the grid. */
  .step:nth-child(4n + 1):not(.on) {
    background: color-mix(in srgb, var(--paper-sunk) 75%, var(--rule-strong));
  }
  .step.on {
    border-color: color-mix(in srgb, var(--pad) 60%, transparent);
  }
  .fill {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--pad);
    opacity: 0.85;
    transition: height 60ms linear;
  }
  .num {
    position: absolute;
    left: 7px;
    top: 5px;
    font-size: 0.7rem;
    color: var(--ink-3);
    mix-blend-mode: difference;
    filter: invert(1);
  }
  .step.on .num {
    color: var(--paper);
    mix-blend-mode: normal;
    filter: none;
  }
  .vel {
    position: absolute;
    right: 7px;
    bottom: 5px;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--paper);
    opacity: 0.9;
  }
  .step.now {
    box-shadow:
      0 0 0 2px var(--paper),
      0 0 0 4px var(--ink);
  }
  .step.dragging {
    transform: scale(1.04);
  }

  /* Pads */
  .pads {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .pad {
    position: relative;
    height: 84px;
    border-radius: 16px;
    border: 1px solid var(--rule-strong);
    background: var(--paper-raised);
    overflow: hidden;
    display: grid;
    place-items: center;
    touch-action: none;
  }
  .pad.selected {
    border-color: var(--pad);
    box-shadow: inset 0 -4px 0 var(--pad);
  }
  .pad:active {
    scale: 0.97;
  }
  .pad-name {
    position: relative;
    font-weight: 600;
  }
  .pad-key {
    position: absolute;
    right: 9px;
    bottom: 7px;
    font-size: 0.7rem;
    color: var(--ink-3);
    font-family: var(--font-mono);
  }
  .flash {
    position: absolute;
    inset: 0;
    opacity: 0;
    background: var(--pad);
  }
  .flash.go {
    animation: flash 220ms ease-out;
  }
  @keyframes flash {
    from {
      opacity: 0.5;
    }
    to {
      opacity: 0;
    }
  }

  /* Settings */
  .settings {
    display: grid;
    gap: 10px;
    padding: 12px 14px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
  }
  .setting {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .setting .label {
    flex: 1;
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  .setting input[type='range'] {
    flex: 1.4;
    accent-color: var(--accent);
  }
  .setting .value {
    min-width: 4.5ch;
    text-align: center;
    font-size: 0.9rem;
  }
  .stepper {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    background: var(--paper-sunk);
    padding: 2px;
  }
  .stepper button {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--ink-2);
  }
  .note {
    margin-right: 2px;
    color: var(--ink-3);
  }

  /* Transport */
  .transport {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px calc(var(--safe-right) + 12px) calc(var(--safe-bottom) + 8px) calc(var(--safe-left) + 12px);
    border-top: 1px solid var(--rule);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .play {
    width: 50px;
    height: 50px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
    flex: none;
  }
  .record {
    width: 42px;
    height: 42px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    border: 1px solid var(--rule-strong);
    flex: none;
  }
  .record .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.5;
  }
  .record.on {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .record.on .dot {
    opacity: 1;
    animation: pulse 1s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.4;
    }
  }
  .position {
    font-size: 1rem;
    min-width: 6ch;
  }
  .save-state {
    font-size: 0.78rem;
    color: var(--ink-3);
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
