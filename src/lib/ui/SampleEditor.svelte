<script lang="ts">
  /**
   * Editing a library sample: its name, where it starts and ends (handles on
   * its waveform), its envelope (attack, decay, release), level, tone (low
   * and high cut), reverb, transposition, reverse, and the note it sounds at
   * (used when a sketch plays its notes with it). The stored audio is never
   * changed: these are settings, saved a moment after each change and heard
   * the next time it plays.
   */
  import { onDestroy, onMount } from 'svelte';
  import { detectPitch } from '../audio/pitch';
  import type { LiveContext } from '../audio/liveContext';
  import type { Sample } from '../library/types';
  import { noteName } from '../music/notes';
  import { errorMessage } from '../platform/tauri';
  import { loadSampleAudio, playOnce, renderSampleData, type MonoAudio } from '../samples/render';
  import { DEFAULT_ROOT, LIMITS, normalizeSampleSettings, trimSpan, type SampleSettings } from '../samples/settings';
  import { app } from '../state/app.svelte';
  import Icon from './Icon.svelte';
  import SampleWave from './SampleWave.svelte';
  import Sheet from './Sheet.svelte';
  import { registerTransport } from './transport';

  interface Props {
    sample: Sample;
    live: LiveContext;
    /** Where the sound goes in a context (the library's limiter). */
    output: (ctx: AudioContext) => AudioNode;
    onclose: () => void;
  }

  let { sample, live, output, onclose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let settings = $state<SampleSettings>(normalizeSampleSettings(sample.settings));
  // svelte-ignore state_referenced_locally
  let title = $state(sample.title);
  let audio = $state.raw<MonoAudio | null>(null);
  let loadError = $state<string | null>(null);
  let saveTimer: number | undefined;
  let saving = $state(false);
  let confirmDelete = $state(false);

  onMount(() => {
    loadSampleAudio(sample).then(
      (a) => (audio = a),
      (error) => (loadError = errorMessage(error)),
    );
    return registerTransport(togglePlay);
  });

  const duration = $derived(audio ? audio.samples.length / audio.sampleRate : (sample.durationMs ?? 1000) / 1000);
  const span = $derived(trimSpan(settings, duration));

  function change(patch: Partial<SampleSettings>) {
    settings = normalizeSampleSettings({ ...settings, ...patch });
    scheduleSave();
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saving = true;
    saveTimer = window.setTimeout(() => void save(), 400);
  }

  async function save() {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    await app.updateSample(sample.id, { title: title.trim(), settings: { ...settings } });
    saving = false;
  }

  function saveTitle() {
    if (title.trim() !== sample.title) scheduleSave();
  }

  onDestroy(() => {
    stop();
    cancelAnimationFrame(frame);
    if (saveTimer !== undefined) void save();
  });

  // ------------------------------------------------------------ playing

  let stopSound: (() => void) | null = null;
  let playing = $state<{ startedAt: number; length: number } | null>(null);
  let playhead = $state<number | null>(null);
  let frame = 0;
  let token = 0;

  function stop() {
    token++;
    stopSound?.();
    stopSound = null;
    playing = null;
    playhead = null;
    cancelAnimationFrame(frame);
  }

  async function play() {
    const ctx = live.wake();
    stop();
    if (!audio) return;
    const mine = ++token;
    let data: Float32Array<ArrayBuffer>;
    try {
      data = await renderSampleData(audio, settings, ctx.sampleRate);
    } catch (error) {
      app.toast(`Could not play the sample: ${errorMessage(error)}`, 'error');
      return;
    }
    if (mine !== token) return;
    const buffer = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
    buffer.copyToChannel(data, 0);
    stopSound = playOnce(ctx, output(ctx), buffer);
    playing = { startedAt: ctx.currentTime, length: buffer.duration };
    const rate = 2 ** (settings.pitch / 12);
    const paint = () => {
      if (!playing) return;
      const elapsed = ctx.currentTime - playing.startedAt;
      if (elapsed >= playing.length) {
        playing = null;
        playhead = null;
        return;
      }
      const inSound = elapsed * rate;
      playhead = inSound > span.to - span.from ? null : settings.reverse ? span.to - inSound : span.from + inSound;
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
  }

  function togglePlay() {
    if (playing) stop();
    else void play();
  }

  // --------------------------------------------------------------- trim

  let waveEl: HTMLDivElement;
  let trimDrag: { edge: 'start' | 'end'; pointer: number } | null = null;

  function trimDown(edge: 'start' | 'end', e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    trimDrag = { edge, pointer: e.pointerId };
  }

  function trimMove(e: PointerEvent) {
    const d = trimDrag;
    if (!d || d.pointer !== e.pointerId) return;
    const rect = waveEl.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
    if (d.edge === 'start') settings = normalizeSampleSettings({ ...settings, start: Math.min(t, span.to - 0.02) });
    else settings = normalizeSampleSettings({ ...settings, end: t >= duration - 0.005 ? null : Math.max(t, span.from + 0.02) });
  }

  function trimUp(e: PointerEvent) {
    if (trimDrag?.pointer !== e.pointerId) return;
    trimDrag = null;
    scheduleSave();
  }

  function trimKey(edge: 'start' | 'end', e: KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.01;
    const delta = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!delta) return;
    e.preventDefault();
    if (edge === 'start') change({ start: Math.max(0, Math.min(span.to - 0.02, span.from + delta)) });
    else change({ end: Math.min(duration, Math.max(span.from + 0.02, span.to + delta)) });
  }

  // --------------------------------------------------------------- root

  const root = $derived(settings.rootPitch ?? DEFAULT_ROOT);

  function detectRoot() {
    if (!audio) return;
    const a = Math.floor(span.from * audio.sampleRate);
    const b = Math.floor(span.to * audio.sampleRate);
    const found = detectPitch(audio.samples.subarray(a, b), audio.sampleRate);
    if (!found) {
      app.toast('No steady pitch found in this sound. Set its note by hand.');
      return;
    }
    change({ rootPitch: found.note, fineCents: found.cents, rootSource: 'detected' });
  }

  function stepRoot(delta: number) {
    change({ rootPitch: Math.min(108, Math.max(21, root + delta)), rootSource: 'user' });
  }

  // ------------------------------------------------------- slider scales

  /** A cutoff (Hz) as a 0–100 position on a log scale between `lo` and `hi`. */
  const toPos = (hz: number, lo: number, hi: number) => (Math.log(hz / lo) / Math.log(hi / lo)) * 100;
  const fromPos = (pos: number, lo: number, hi: number) => Math.round(lo * (hi / lo) ** (pos / 100));
  const [LP_LO, LP_HI] = LIMITS.lowpassHz;
  const [HP_LO, HP_HI] = LIMITS.highpassHz;
  const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${v} Hz`);
  const ms = (s: number) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);

  async function remove() {
    confirmDelete = false;
    stop();
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    onclose();
    await app.deleteSample(sample.id);
  }
</script>

<div class="editor" role="dialog" aria-label="Edit sample">
  <header class="bar">
    <button class="icon-button" onclick={onclose} aria-label="Back to the samples"><Icon name="back" /></button>
    <input class="title-input serif" bind:value={title} oninput={saveTitle} placeholder="Sample" maxlength="120" aria-label="Name" />
    <span class="save-state" aria-live="polite">{saving ? 'Saving…' : ''}</span>
    <button class="icon-button" onclick={() => (confirmDelete = true)} aria-label="Delete sample"><Icon name="trash" /></button>
  </header>

  <main class="content">
    <section class="wave-area" aria-label="Waveform">
      <div class="wave-box" bind:this={waveEl}>
        {#if loadError}
          <p class="hint">The sound could not be read: {loadError}</p>
        {:else}
          <SampleWave samples={audio?.samples ?? null} sampleRate={audio?.sampleRate ?? 44100} from={span.from} to={span.to} {playhead} />
        {/if}
        {#each ['start', 'end'] as const as edge (edge)}
          {@const t = edge === 'start' ? span.from : span.to}
          <div
            class="trim {edge}"
            style:left="{(t / duration) * 100}%"
            role="slider"
            tabindex="0"
            aria-label={edge === 'start' ? 'Start' : 'End'}
            aria-valuemin="0"
            aria-valuemax={Math.round(duration * 100) / 100}
            aria-valuenow={Math.round(t * 100) / 100}
            onpointerdown={(e) => trimDown(edge, e)}
            onpointermove={trimMove}
            onpointerup={trimUp}
            onpointercancel={trimUp}
            onkeydown={(e) => trimKey(edge, e)}
          >
            <span class="grip"></span>
          </div>
        {/each}
      </div>
      <div class="wave-foot">
        <button class="play" onclick={togglePlay} disabled={!audio} aria-label={playing ? 'Stop' : 'Play'}>
          <Icon name={playing ? 'stop' : 'play'} size={20} />
        </button>
        <span class="tabular dim">{ms(span.from)} – {ms(span.to)} · {ms(span.to - span.from)}</span>
        <span class="spacer"></span>
        {#if settings.start > 0 || settings.end !== null}
          <button class="link" onclick={() => change({ start: 0, end: null })}>Whole sound</button>
        {/if}
      </div>
    </section>

    <section class="group" aria-label="Envelope">
      <h3>Shape</h3>
      <label class="row">
        <span class="label">Level</span>
        <input type="range" min={LIMITS.gainDb[0]} max={LIMITS.gainDb[1]} step="0.5" value={settings.gainDb} oninput={(e) => change({ gainDb: Number(e.currentTarget.value) })} />
        <span class="value tabular">{settings.gainDb > 0 ? '+' : ''}{settings.gainDb} dB</span>
      </label>
      <label class="row">
        <span class="label">Attack</span>
        <input type="range" min="0" max="1" step="0.001" value={settings.attack} oninput={(e) => change({ attack: Number(e.currentTarget.value) })} />
        <span class="value tabular">{ms(settings.attack)}</span>
      </label>
      <label class="row">
        <span class="label">Decay</span>
        <input type="range" min="0" max={LIMITS.decay[1]} step="0.05" value={settings.decay} oninput={(e) => change({ decay: Number(e.currentTarget.value) })} />
        <span class="value tabular">{settings.decay === 0 ? 'Off' : ms(settings.decay)}</span>
      </label>
      <label class="row">
        <span class="label">Release</span>
        <input type="range" min="0" max={LIMITS.release[1]} step="0.005" value={settings.release} oninput={(e) => change({ release: Number(e.currentTarget.value) })} />
        <span class="value tabular">{ms(settings.release)}</span>
      </label>
      <div class="toggles">
        <label class="check"><input type="checkbox" checked={settings.normalize} onchange={(e) => change({ normalize: e.currentTarget.checked })} /> Normalize</label>
        <label class="check"><input type="checkbox" checked={settings.reverse} onchange={(e) => change({ reverse: e.currentTarget.checked })} /> Reverse</label>
      </div>
    </section>

    <section class="group" aria-label="Effects">
      <h3>Effects</h3>
      <label class="row">
        <span class="label">Reverb</span>
        <input type="range" min="0" max="100" step="1" value={Math.round(settings.reverb * 100)} oninput={(e) => change({ reverb: Number(e.currentTarget.value) / 100 })} />
        <span class="value tabular">{settings.reverb === 0 ? 'Off' : `${Math.round(settings.reverb * 100)}%`}</span>
      </label>
      <label class="row" class:muted={settings.reverb === 0}>
        <span class="label">Room</span>
        <input type="range" min={LIMITS.reverbSize[0]} max={LIMITS.reverbSize[1]} step="0.1" value={settings.reverbSize} oninput={(e) => change({ reverbSize: Number(e.currentTarget.value) })} />
        <span class="value tabular">{settings.reverbSize.toFixed(1)} s</span>
      </label>
      <label class="row">
        <span class="label">Tone</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={settings.lowpassHz === null ? 100 : toPos(settings.lowpassHz, LP_LO, LP_HI)}
          oninput={(e) => {
            const pos = Number(e.currentTarget.value);
            change({ lowpassHz: pos >= 100 ? null : fromPos(pos, LP_LO, LP_HI) });
          }}
          aria-label="Tone (high cut)"
        />
        <span class="value tabular">{settings.lowpassHz === null ? 'Open' : hz(settings.lowpassHz)}</span>
      </label>
      <label class="row">
        <span class="label">Low cut</span>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={settings.highpassHz === null ? 0 : toPos(settings.highpassHz, HP_LO, HP_HI)}
          oninput={(e) => {
            const pos = Number(e.currentTarget.value);
            change({ highpassHz: pos <= 0 ? null : fromPos(pos, HP_LO, HP_HI) });
          }}
        />
        <span class="value tabular">{settings.highpassHz === null ? 'Off' : hz(settings.highpassHz)}</span>
      </label>
      <label class="row">
        <span class="label">Transpose</span>
        <input type="range" min={LIMITS.pitch[0]} max={LIMITS.pitch[1]} step="1" value={settings.pitch} oninput={(e) => change({ pitch: Number(e.currentTarget.value) })} />
        <span class="value tabular">{settings.pitch > 0 ? '+' : ''}{settings.pitch} st</span>
      </label>
    </section>

    <section class="group" aria-label="Note">
      <h3>Note</h3>
      <div class="row">
        <span class="label">Sounds at</span>
        <div class="stepper">
          <button onclick={() => stepRoot(-1)} aria-label="A semitone lower"><Icon name="minus" size={16} /></button>
          <span class="value tabular note-name">{noteName(root)}{#if settings.fineCents !== 0}<span class="cents"> {settings.fineCents > 0 ? '+' : ''}{settings.fineCents}¢</span>{/if}</span>
          <button onclick={() => stepRoot(1)} aria-label="A semitone higher"><Icon name="plus" size={16} /></button>
        </div>
        <button class="chip-button" onclick={detectRoot} disabled={!audio}>Detect</button>
      </div>
      <p class="hint">
        {#if settings.rootPitch === null}No steady pitch was found, so C4 is assumed.{:else if settings.rootSource === 'detected'}Found in the sound.{:else}Set by hand.{/if}
        A sketch that plays its notes with this sample (its ⋯ menu → <em>Use sample</em>) plays each note from here, faster for
        higher notes and slower for lower ones; rhythm pads play it as it is.
      </p>
    </section>
  </main>
</div>

{#if confirmDelete}
  <Sheet title="Delete this sample?" onclose={() => (confirmDelete = false)}>
    <p class="confirm-text">Rhythm pads that play it go back to their own sounds, and sketches whose notes play with it go back to the piano.</p>
    <div class="confirm-actions">
      <button class="pill-button danger" onclick={remove}>Delete</button>
      <button class="pill-button" onclick={() => (confirmDelete = false)}>Cancel</button>
    </div>
  </Sheet>
{/if}

<style>
  .editor {
    position: fixed;
    inset: 0;
    z-index: 30;
    overflow-y: auto;
    background: var(--paper);
    padding-bottom: calc(var(--safe-bottom) + 24px);
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 6px) 6px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .title-input {
    flex: 1;
    min-width: 0;
    font-size: 1.2rem;
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
  .save-state {
    font-size: 0.78rem;
    color: var(--ink-3);
  }
  .content {
    display: grid;
    gap: 18px;
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: 14px calc(var(--safe-right) + 14px) 0 calc(var(--safe-left) + 14px);
  }
  .wave-box {
    position: relative;
    height: 120px;
    border-radius: var(--radius);
    border: 1px solid var(--rule);
    background: var(--paper-raised);
    overflow: hidden;
    touch-action: pan-y;
  }
  .trim {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 28px;
    margin-left: -14px;
    display: grid;
    place-items: center;
    cursor: ew-resize;
    touch-action: none;
    outline: none;
  }
  .trim .grip {
    width: 6px;
    height: 70%;
    border-radius: 3px;
    background: var(--chord);
    box-shadow: 0 0 0 2px var(--paper-raised);
  }
  .trim:focus-visible .grip {
    background: var(--accent);
  }
  .wave-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .play {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
    flex: none;
  }
  .dim {
    color: var(--ink-3);
    font-size: 0.82rem;
  }
  .spacer {
    flex: 1;
  }
  .link {
    font-size: 0.85rem;
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .group {
    display: grid;
    gap: 8px;
    padding: 12px 14px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
  }
  h3 {
    margin: 0 0 2px;
    font-size: 0.75rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ink-3);
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 34px;
  }
  .row.muted {
    opacity: 0.5;
  }
  .label {
    width: 5.5em;
    flex: none;
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  .row input[type='range'] {
    flex: 1;
    min-width: 0;
    accent-color: var(--accent);
    touch-action: pan-y;
  }
  .value {
    min-width: 5.2em;
    text-align: right;
    font-size: 0.85rem;
  }
  .toggles {
    display: flex;
    gap: 18px;
    padding-top: 2px;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
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
  .note-name {
    min-width: 5em;
    text-align: center;
    font-weight: 600;
  }
  .cents {
    font-weight: 400;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .chip-button {
    min-height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--rule-strong);
    font-size: 0.82rem;
    color: var(--ink-2);
  }
  .hint {
    margin: 0;
    font-size: 0.8rem;
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
