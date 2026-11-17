<script lang="ts">
  /**
   * The sample library: every sample as a button showing its waveform and
   * name. Tap one to hear it (tap again to stop); press and hold (or
   * right-click) for its menu, which opens the editor (trim, envelope,
   * effects, root note) or deletes it. Samples come from a sketch's
   * waveform: hold Ctrl and drag across it, or press and hold it for two
   * seconds, then *Add to library*.
   */
  import { onDestroy, onMount } from 'svelte';
  import { LiveContext } from '../audio/liveContext';
  import type { Sample } from '../library/types';
  import { errorMessage } from '../platform/tauri';
  import { loadSampleAudio, playOnce, sampleBuffer, type MonoAudio } from '../samples/render';
  import { normalizeSampleSettings, trimSpan } from '../samples/settings';
  import { app } from '../state/app.svelte';
  import Icon from './Icon.svelte';
  import SampleEditor from './SampleEditor.svelte';
  import SampleWave from './SampleWave.svelte';
  import Sheet from './Sheet.svelte';
  import { registerTransport } from './transport';

  const HOLD_MS = 500;
  const SLOP = 8;

  const samples = $derived(app.samples);

  // ------------------------------------------------------------ sound

  /** The library's own audio context, renewed when it may be stuck (see LiveContext). */
  const live = new LiveContext({
    latencyHint: 'interactive',
    onRenew: () => {
      outputs = new WeakMap();
      stop();
    },
    onHidden: () => stop(),
    log: (message) => app.logCapture(`[samples] ${message}`),
  });
  let outputs = new WeakMap<AudioContext, AudioNode>();

  /** A limiter in front of the speakers (once per context). */
  function output(ctx: AudioContext): AudioNode {
    let node = outputs.get(ctx);
    if (!node) {
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.ratio.value = 12;
      limiter.connect(ctx.destination);
      node = limiter;
      outputs.set(ctx, node);
    }
    return node;
  }

  let playing = $state<{ id: string; startedAt: number; length: number } | null>(null);
  let progress = $state(0);
  let stopSound: (() => void) | null = null;
  let token = 0;
  let frame = 0;
  /** The sample last played: the space bar plays it again. */
  let lastId: string | null = null;

  function stop() {
    token++;
    stopSound?.();
    stopSound = null;
    playing = null;
    progress = 0;
    cancelAnimationFrame(frame);
  }

  async function play(sample: Sample) {
    const ctx = live.wake();
    if (playing?.id === sample.id) {
      stop();
      return;
    }
    stop();
    lastId = sample.id;
    const mine = ++token;
    let buffer: AudioBuffer;
    try {
      buffer = await sampleBuffer(ctx, sample);
    } catch (error) {
      app.toast(`Could not play “${sample.title || 'the sample'}”: ${errorMessage(error)}`, 'error');
      return;
    }
    if (mine !== token) return;
    stopSound = playOnce(ctx, output(ctx), buffer);
    playing = { id: sample.id, startedAt: ctx.currentTime, length: buffer.duration };
    const paint = () => {
      if (!playing) return;
      progress = Math.min(1, (ctx.currentTime - playing.startedAt) / playing.length);
      if (progress >= 1) {
        playing = null;
        progress = 0;
        return;
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
  }

  /** The space bar: the sample last played (or the first), or stop. */
  function onSpace() {
    if (editing) return;
    if (playing) {
      stop();
      return;
    }
    const sample = samples.find((s) => s.id === lastId) ?? samples[0];
    if (sample) void play(sample);
  }

  // ------------------------------------------------------------ waveforms

  let audio = $state.raw<Record<string, MonoAudio>>({});
  $effect(() => {
    for (const s of samples) {
      if (audio[s.id] || !s.audioPath) continue;
      const id = s.id;
      loadSampleAudio(s).then(
        (a) => (audio = { ...audio, [id]: a }),
        () => {},
      );
    }
  });

  // ------------------------------------------------------------ gestures

  let press: { id: string; pointer: number; x: number; y: number; held: boolean } | null = null;
  let holdTimer: number | undefined;
  let menu = $state<{ id: string; x: number; y: number } | null>(null);
  let editing = $state<string | null>(null);
  let confirming = $state<string | null>(null);

  function down(e: PointerEvent, id: string) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Inside the gesture: WebKit starts audio only here.
    live.wake();
    press = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, held: false };
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      if (!press || press.id !== id) return;
      press.held = true;
      navigator.vibrate?.(12);
      menu = { id, x: press.x, y: press.y };
    }, HOLD_MS);
  }

  function move(e: PointerEvent) {
    if (!press || press.pointer !== e.pointerId) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) {
      window.clearTimeout(holdTimer);
      press = null;
    }
  }

  function up(e: PointerEvent, sample: Sample) {
    const p = press;
    press = null;
    window.clearTimeout(holdTimer);
    if (!p || p.pointer !== e.pointerId || p.held) return;
    void play(sample);
  }

  function onContext(e: MouseEvent, id: string) {
    e.preventDefault();
    menu = { id, x: e.clientX, y: e.clientY };
  }

  function onKeyTile(e: KeyboardEvent, sample: Sample) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void play(sample);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      menu = { id: sample.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }

  function openEditor(id: string) {
    menu = null;
    stop();
    editing = id;
  }

  function onWindowDown(e: PointerEvent) {
    if (menu && !(e.target as HTMLElement).closest('.popover')) menu = null;
  }

  async function confirmDelete() {
    const id = confirming;
    confirming = null;
    if (!id) return;
    if (playing?.id === id) stop();
    await app.deleteSample(id);
  }

  /** Keep a popover of `w`×`h` on screen near (x, y). */
  function placeMenu(x: number, y: number, w: number, h: number) {
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2));
    const above = y - h - 14;
    const top = above > 8 ? above : Math.min(window.innerHeight - h - 8, y + 14);
    return { left, top };
  }

  const seconds = (s: Sample) => {
    const a = audio[s.id];
    const length = a ? a.samples.length / a.sampleRate : (s.durationMs ?? 0) / 1000;
    const { from, to } = trimSpan(normalizeSampleSettings(s.settings), length);
    return to - from;
  };

  onMount(() => registerTransport(onSpace));

  onDestroy(() => {
    stop();
    window.clearTimeout(holdTimer);
    live.dispose();
  });

  const editingSample = $derived(editing ? (samples.find((s) => s.id === editing) ?? null) : null);
  const menuSample = $derived(menu ? (samples.find((s) => s.id === menu!.id) ?? null) : null);
</script>

<svelte:window onpointerdowncapture={onWindowDown} onkeydown={(e) => e.key === 'Escape' && (menu = null)} />

<div class="library">
  <header class="bar">
    <button class="icon-button" onclick={() => app.goHome()} aria-label="Back to the notebook"><Icon name="back" /></button>
    <h1 class="serif">Samples</h1>
    <span class="count tabular">{samples.length || ''}</span>
  </header>

  <main class="content">
    {#if samples.length === 0}
      <div class="empty">
        <p class="serif lead">No samples yet.</p>
        <p>
          Open a sketch and, on its waveform, hold <kbd>Ctrl</kbd> and drag across a passage, or press and hold for two
          seconds (then drag). Tap <em>Add to library</em>, and it appears here.
        </p>
        <p>Rhythm pads can play samples, and a sketch can play its notes with one.</p>
      </div>
    {:else}
      <ul class="grid" aria-label="Samples">
        {#each samples as s (s.id)}
          {@const a = audio[s.id] ?? null}
          {@const settings = normalizeSampleSettings(s.settings)}
          {@const span = trimSpan(settings, a ? a.samples.length / a.sampleRate : (s.durationMs ?? 1000) / 1000)}
          <li>
            <button
              class="tile"
              class:playing={playing?.id === s.id}
              data-sample={s.id}
              onpointerdown={(e) => down(e, s.id)}
              onpointermove={move}
              onpointerup={(e) => up(e, s)}
              onpointercancel={() => (press = null)}
              oncontextmenu={(e) => onContext(e, s.id)}
              onkeydown={(e) => onKeyTile(e, s)}
              aria-label="{s.title || 'Sample'}: play (hold for its menu)"
            >
              <span class="wave">
                <SampleWave samples={a?.samples ?? null} sampleRate={a?.sampleRate ?? 44100} from={span.from} to={span.to} />
                {#if playing?.id === s.id}<span class="progress" style:width="{progress * 100}%"></span>{/if}
              </span>
              <span class="name">{s.title || 'Sample'}</span>
              <span class="meta tabular">{seconds(s).toFixed(1)} s</span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="tip">Tap to hear a sample. Press and hold for its menu.</p>
    {/if}
  </main>
</div>

{#if menu && menuSample}
  {@const m = menu}
  {@const at = placeMenu(m.x, m.y, 220, 110)}
  <div class="popover" role="menu" style:left="{at.left}px" style:top="{at.top}px" aria-label={menuSample.title || 'Sample'}>
    <div class="menu-label">{menuSample.title || 'Sample'}</div>
    <button role="menuitem" onclick={() => openEditor(m.id)}><Icon name="edit" size={18} /> Edit sample…</button>
    <button role="menuitem" class="danger" onclick={() => ((confirming = m.id), (menu = null))}><Icon name="trash" size={18} /> Delete</button>
  </div>
{/if}

{#if editingSample}
  <SampleEditor sample={editingSample} {live} {output} onclose={() => (editing = null)} />
{/if}

{#if confirming}
  <Sheet title="Delete this sample?" onclose={() => (confirming = null)}>
    <p class="confirm-text">Rhythm pads that play it go back to their own sounds, and sketches whose notes play with it go back to the piano.</p>
    <div class="confirm-actions">
      <button class="pill-button danger" onclick={confirmDelete}>Delete</button>
      <button class="pill-button" onclick={() => (confirming = null)}>Cancel</button>
    </div>
  </Sheet>
{/if}

<style>
  .library {
    min-height: 100vh;
    min-height: 100dvh;
    padding-bottom: calc(var(--safe-bottom) + 24px);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 12px) 6px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  h1 {
    margin: 0;
    font-size: 1.45rem;
  }
  .count {
    color: var(--ink-3);
    font-size: 0.9rem;
  }
  .content {
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
    padding: 16px calc(var(--safe-right) + 14px) 0 calc(var(--safe-left) + 14px);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
  .tile {
    width: 100%;
    display: grid;
    gap: 6px;
    padding: 10px;
    border-radius: var(--radius);
    border: 1px solid var(--rule);
    background: var(--paper-raised);
    text-align: left;
    touch-action: manipulation;
    -webkit-touch-callout: none;
    transition: transform 80ms ease;
  }
  .tile:active {
    transform: scale(0.98);
  }
  .tile.playing {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .wave {
    position: relative;
    display: block;
    height: 64px;
    border-radius: 8px;
    background: var(--paper-sunk);
    overflow: hidden;
    --wave-ink: var(--note);
  }
  .progress {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    background: var(--accent-soft);
    border-right: 2px solid var(--accent);
    pointer-events: none;
  }
  .name {
    font-weight: 600;
    font-size: 0.92rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: 0.75rem;
    color: var(--ink-3);
    margin-top: -4px;
  }
  .tip {
    margin: 18px 0 0;
    font-size: 0.8rem;
    color: var(--ink-3);
    text-align: center;
  }
  .empty {
    max-width: 420px;
    margin: 12vh auto 0;
    text-align: center;
    color: var(--ink-2);
  }
  .lead {
    margin: 0 0 8px;
    font-size: 1.5rem;
    color: var(--ink);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--rule-strong);
  }
  .popover {
    position: fixed;
    z-index: 30;
    width: 220px;
    display: grid;
    padding: 6px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    box-shadow: var(--shadow);
  }
  .popover button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    border-radius: var(--radius-sm);
    text-align: left;
    font-size: 0.95rem;
  }
  .popover button:hover {
    background: var(--paper-sunk);
  }
  .menu-label {
    padding: 4px 10px;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .danger {
    color: var(--accent);
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
