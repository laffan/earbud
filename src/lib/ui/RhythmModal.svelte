<script lang="ts">
  /**
   * Recording and editing a rhythm sketch, in a panel that can be dragged
   * out of the way of the canvas.
   *
   * Record: three pads (Beat 1, 2, 3: a kick, a snare and a hat; keys 1 2 3 or J K L). Recording
   * starts with the first tap and ends with Done. The taps then become a
   * step pattern (`patternFromTaps`: tempo detected, 16th-note grid, whole
   * bars), shown as a step sequencer: tap a step to switch it, change the
   * tempo or the number of bars, play it in a loop, or record again.
   */
  import { onDestroy } from 'svelte';
  import { DrumKit } from '../music/drums';
  import { RhythmPlayer } from '../music/rhythmPlayer';
  import {
    MAX_BARS,
    MAX_BPM,
    MIN_BPM,
    PADS,
    patternFromTaps,
    patternSteps,
    stepsPerBar,
    withBars,
    withStep,
    type RhythmPattern,
    type Tap,
  } from '../music/rhythm';
  import Icon from './Icon.svelte';

  interface Props {
    /** The audio context and the mix input the pads sound through (the canvas's). */
    context: () => AudioContext;
    destination: () => AudioNode;
    /** Wake the audio inside a tap (WebKit). */
    unlock: () => void;
    /** Editing an existing rhythm (null: record a new one). */
    initial: RhythmPattern | null;
    initialTitle?: string;
    onsave: (pattern: RhythmPattern, title: string) => void | Promise<void>;
    onclose: () => void;
  }

  let { context, destination, unlock, initial, initialTitle = '', onsave, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let phase = $state<'record' | 'edit'>(initial ? 'edit' : 'record');
  // svelte-ignore state_referenced_locally
  let pattern = $state.raw<RhythmPattern | null>(initial);
  // svelte-ignore state_referenced_locally
  let title = $state(initialTitle);
  let taps: Tap[] = [];
  let tapCount = $state(0);
  let recordingSince = $state<number | null>(null);
  let now = $state(performance.now());
  let lit = $state<number[]>([0, 0, 0]);
  let detected = $state<boolean | null>(null);
  let saving = $state(false);

  // svelte-ignore state_referenced_locally
  const kit = new DrumKit(context(), destination());

  // ------------------------------------------------------------ the pads

  function strike(pad: number, at: number) {
    unlock();
    kit.hit(pad);
    lit = lit.map((v, i) => (i === pad ? v + 1 : v));
    if (phase !== 'record') return;
    if (recordingSince === null) recordingSince = at;
    taps.push({ pad, time: at / 1000 });
    tapCount = taps.length;
  }

  function padDown(e: PointerEvent, pad: number) {
    e.preventDefault();
    strike(pad, e.timeStamp || performance.now());
  }

  function onKey(e: KeyboardEvent) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'Escape') {
      onclose();
      return;
    }
    const pad = PADS.findIndex((p) => p.keys.includes(e.key.toLowerCase()));
    if (pad >= 0) {
      e.preventDefault();
      strike(pad, e.timeStamp || performance.now());
    } else if (e.key === ' ' && phase === 'edit') {
      e.preventDefault();
      togglePreview();
    }
  }

  const clock = window.setInterval(() => (now = performance.now()), 200);

  function finishRecording() {
    const result = patternFromTaps(taps);
    if (!result) return;
    pattern = result.pattern;
    detected = result.detected;
    phase = 'edit';
  }

  function recordAgain() {
    stopPreview();
    taps = [];
    tapCount = 0;
    recordingSince = null;
    detected = null;
    phase = 'record';
  }

  // ------------------------------------------------------------- editing

  function toggleStep(pad: number, step: number) {
    if (!pattern) return;
    const on = (pattern.pads[pad][step] ?? 0) > 0;
    pattern = withStep(pattern, pad, step, on ? 0 : 1);
    if (!on && !previewing) {
      unlock();
      kit.hit(pad);
    }
  }

  function setBpm(bpm: number) {
    if (!pattern || !Number.isFinite(bpm)) return;
    pattern = { ...pattern, bpm: Math.round(Math.min(MAX_BPM, Math.max(MIN_BPM, bpm)) * 10) / 10 };
  }

  function setBars(bars: number) {
    if (!pattern) return;
    pattern = withBars(pattern, bars);
  }

  // ------------------------------------------------------------- preview

  let previewing = $state(false);
  let currentStep = $state(-1);
  let frame = 0;
  // svelte-ignore state_referenced_locally
  const player = new RhythmPlayer(context(), kit, () => pattern);

  function togglePreview() {
    if (previewing) stopPreview();
    else startPreview();
  }

  function startPreview() {
    if (!pattern) return;
    unlock();
    previewing = true;
    player.start();
    const paint = () => {
      currentStep = player.currentStep();
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
  }

  function stopPreview() {
    previewing = false;
    player.stop();
    cancelAnimationFrame(frame);
    currentStep = -1;
  }

  async function save() {
    if (!pattern || saving) return;
    stopPreview();
    saving = true;
    try {
      await onsave(pattern, title.trim());
    } finally {
      saving = false;
    }
  }

  onDestroy(() => {
    stopPreview();
    window.clearInterval(clock);
    kit.dispose();
  });

  // ------------------------------------------------------------ dragging

  let panel: HTMLDivElement;
  let pos = $state<{ x: number; y: number } | null>(null);
  let grab: { dx: number; dy: number } | null = null;

  function grabDown(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button, input')) return;
    const rect = panel.getBoundingClientRect();
    pos = { x: rect.left, y: rect.top };
    grab = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function grabMove(e: PointerEvent) {
    if (!grab) return;
    const rect = panel.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 60, Math.max(60 - rect.width, e.clientX - grab.dx));
    const y = Math.min(window.innerHeight - 48, Math.max(0, e.clientY - grab.dy));
    pos = { x, y };
  }

  function grabUp() {
    grab = null;
  }

  const elapsed = $derived(recordingSince === null ? 0 : Math.max(0, (now - recordingSince) / 1000));
  const perBar = $derived(pattern ? stepsPerBar(pattern) : 16);
</script>

<svelte:window onkeydown={onKey} />

<div
  class="panel"
  bind:this={panel}
  class:placed={pos !== null}
  style:left={pos ? `${pos.x}px` : undefined}
  style:top={pos ? `${pos.y}px` : undefined}
  role="dialog"
  aria-label={phase === 'record' ? 'Record a rhythm' : 'Edit rhythm'}
>
  <div
    class="grab"
    role="toolbar"
    tabindex="-1"
    aria-label="Drag to move"
    onpointerdown={grabDown}
    onpointermove={grabMove}
    onpointerup={grabUp}
    onpointercancel={grabUp}
  >
    <span class="grabber" aria-hidden="true"></span>
    <h2 class="serif">{phase === 'record' ? 'Record a rhythm' : initial ? 'Rhythm' : 'Your rhythm'}</h2>
    <button class="icon-button" onclick={onclose} aria-label="Close"><Icon name="close" /></button>
  </div>

  {#if phase === 'edit' && pattern}
    <div class="edit-head">
      <input class="title" bind:value={title} placeholder="Rhythm" maxlength="120" aria-label="Title" />
    </div>
    <div class="controls">
      <button class="play" onclick={togglePreview} aria-label={previewing ? 'Stop' : 'Play'}>
        <Icon name={previewing ? 'pause' : 'play'} size={18} />
      </button>
      <div class="stepper" role="group" aria-label="Tempo">
        <button onclick={() => setBpm(Math.round(pattern!.bpm) - 1)} aria-label="Slower"><Icon name="minus" size={16} /></button>
        <span class="value tabular"><span class="note" aria-hidden="true">♩</span>{pattern.bpm % 1 === 0 ? pattern.bpm : pattern.bpm.toFixed(1)}</span>
        <button onclick={() => setBpm(Math.round(pattern!.bpm) + 1)} aria-label="Faster"><Icon name="plus" size={16} /></button>
      </div>
      <div class="stepper" role="group" aria-label="Bars">
        <button onclick={() => setBars(pattern!.bars - 1)} disabled={pattern.bars <= 1} aria-label="Fewer bars"><Icon name="minus" size={16} /></button>
        <span class="value tabular">{pattern.bars} bar{pattern.bars === 1 ? '' : 's'}</span>
        <button onclick={() => setBars(pattern!.bars + 1)} disabled={pattern.bars >= MAX_BARS} aria-label="More bars"><Icon name="plus" size={16} /></button>
      </div>
    </div>
    {#if detected === false}
      <p class="hint">Too few taps to be sure of the tempo; set it here.</p>
    {/if}

    <div class="grid-scroll">
      <div class="grid" style:--steps={patternSteps(pattern)}>
        {#each PADS as pad, p (pad.name)}
          <span class="row-label">{pad.name}</span>
          <div class="row" role="group" aria-label={pad.name}>
            {#each pattern.pads[p] as level, s (s)}
              <button
                class="step pad-{p}"
                class:on={level > 0}
                class:beat={s % pattern.stepsPerBeat === 0}
                class:bar={s % perBar === 0 && s > 0}
                class:now={s === currentStep}
                aria-pressed={level > 0}
                aria-label="{pad.name}, step {s + 1}"
                onclick={() => toggleStep(p, s)}
              ></button>
            {/each}
          </div>
        {/each}
      </div>
    </div>

    <div class="footer">
      <button class="pill-button" onclick={recordAgain}><span class="rec-dot" aria-hidden="true"></span> Record again</button>
      <span class="spacer"></span>
      <button class="pill-button" onclick={onclose}>Cancel</button>
      <button class="pill-button primary" onclick={save} disabled={saving}>Save</button>
    </div>
  {:else}
    <p class="status" aria-live="polite">
      {#if recordingSince === null}
        Tap a rhythm on the pads. Recording starts with the first tap.
      {:else}
        <span class="dot" aria-hidden="true"></span>
        <span class="tabular">{elapsed.toFixed(1)} s · {tapCount} tap{tapCount === 1 ? '' : 's'}</span>
      {/if}
    </p>
  {/if}

  <div class="pads" class:small={phase === 'edit'}>
    {#each PADS as pad, p (pad.name)}
      <button class="pad pad-{p}" onpointerdown={(e) => padDown(e, p)} aria-label="{pad.name} (key {pad.keys[0]})">
        {#key lit[p]}<span class="flash" class:go={lit[p] > 0}></span>{/key}
        <span class="pad-name">{pad.name}</span>
        <span class="pad-key">{pad.keys[0]}</span>
      </button>
    {/each}
  </div>

  {#if phase === 'record'}
    <div class="footer">
      <button class="pill-button" onclick={onclose}>Cancel</button>
      <span class="spacer"></span>
      <button class="pill-button primary" onclick={finishRecording} disabled={tapCount === 0}>Done</button>
    </div>
  {/if}
</div>

<style>
  .panel {
    position: fixed;
    z-index: 35;
    left: 50%;
    bottom: calc(var(--safe-bottom) + 150px);
    transform: translateX(-50%);
    width: min(420px, calc(100vw - 20px));
    max-height: calc(100dvh - var(--safe-top) - 20px);
    overflow-y: auto;
    display: grid;
    gap: 12px;
    padding: 6px 14px 14px;
    border-radius: 18px;
    background: var(--paper-raised);
    border: 1px solid var(--rule-strong);
    box-shadow: 0 14px 40px rgb(30 20 5 / 28%);
    animation: rise 160ms ease;
  }
  .panel.placed {
    transform: none;
    bottom: auto;
  }
  @keyframes rise {
    from {
      opacity: 0;
      translate: 0 16px;
    }
  }
  .grab {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .grabber {
    position: absolute;
    top: 2px;
    left: 50%;
    width: 40px;
    height: 4px;
    margin-left: -20px;
    border-radius: 2px;
    background: var(--rule-strong);
  }
  h2 {
    flex: 1;
    margin: 6px 0 0;
    font-size: 1.15rem;
  }
  .status {
    margin: 0;
    min-height: 1.4em;
    color: var(--ink-2);
    font-size: 0.9rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1s ease-in-out infinite alternate;
  }
  @keyframes blink {
    to {
      opacity: 0.3;
    }
  }
  .hint {
    margin: -4px 0 0;
    font-size: 0.8rem;
    color: var(--warn);
  }
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
    aspect-ratio: 1;
    border-radius: 16px;
    border: 1px solid var(--rule-strong);
    background: var(--paper-sunk);
    display: grid;
    place-items: center;
    overflow: hidden;
    touch-action: none;
  }
  .pads.small .pad {
    aspect-ratio: auto;
    height: 64px;
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
    right: 8px;
    bottom: 6px;
    font-size: 0.7rem;
    color: var(--ink-3);
    font-family: var(--font-mono);
  }
  .flash {
    position: absolute;
    inset: 0;
    opacity: 0;
  }
  .flash.go {
    animation: flash 220ms ease-out;
  }
  .pad-0 .flash,
  .step.pad-0.on {
    background: var(--ink-2);
  }
  .pad-1 .flash,
  .step.pad-1.on {
    background: var(--accent);
  }
  .pad-2 .flash,
  .step.pad-2.on {
    background: var(--chord);
  }
  @keyframes flash {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 0;
    }
  }
  .edit-head .title {
    width: 100%;
    font-family: var(--font-serif);
    font-size: 1.05rem;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    background: var(--paper);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .play {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
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
  .stepper .value {
    min-width: 5ch;
    text-align: center;
    font-size: 0.9rem;
  }
  .note {
    margin-right: 2px;
    color: var(--ink-3);
  }
  .grid-scroll {
    overflow-x: auto;
    margin: 0 -14px;
    padding: 0 14px 4px;
    -webkit-overflow-scrolling: touch;
  }
  .grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 8px;
    align-items: center;
    width: max-content;
  }
  .row-label {
    font-size: 0.75rem;
    color: var(--ink-3);
    position: sticky;
    left: 0;
    background: var(--paper-raised);
    padding-right: 4px;
    z-index: 1;
  }
  .row {
    display: flex;
    gap: 2px;
  }
  .step {
    width: 18px;
    height: 28px;
    border-radius: 4px;
    background: var(--paper-sunk);
    border: 1px solid var(--rule);
    flex: none;
  }
  .step.beat:not(.on) {
    background: color-mix(in srgb, var(--paper-sunk) 70%, var(--rule-strong));
  }
  .step.beat {
    margin-left: 4px;
  }
  .step.bar {
    margin-left: 12px;
  }
  .step.now {
    outline: 2px solid var(--ink);
    outline-offset: 1px;
  }
  .step.on {
    border-color: transparent;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .rec-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
