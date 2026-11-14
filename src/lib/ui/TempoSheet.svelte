<script lang="ts">
  /**
   * The sketch's tempo: type it, slide it, or tap it, while the sketch plays
   * with a click on the beat so it can be matched by ear. Also the playback
   * speed, and detecting the tempo again from the first track's notes.
   */
  import type { TempoSource } from '../library/types';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  interface Props {
    bpm: number | null;
    source: TempoSource | null;
    playing: boolean;
    rate: number;
    /** The first track has notes to detect a tempo from. */
    canDetect: boolean;
    /** A new tempo; `tap` says it was tapped (the last tap was a beat). */
    onchange: (bpm: number, tap?: boolean) => void;
    onclear: () => void;
    /** Detect again; returns whether a steady tempo was found. */
    ondetect: () => boolean;
    ontoggleplay: () => void;
    onrate: (rate: number) => void;
    onclose: () => void;
  }

  let { bpm, source, playing, rate, canDetect, onchange, onclear, ondetect, ontoggleplay, onrate, onclose }: Props =
    $props();

  const MIN = 40;
  const MAX = 220;
  const shown = (value: number) => String(Math.round(value * 10) / 10);

  let typed = $state('');
  let detectMessage = $state<string | null>(null);
  $effect(() => {
    // Keep the field in step unless it is being typed in.
    const value = bpm;
    if (document.activeElement?.id !== 'tempo-value') typed = value === null ? '' : shown(value);
  });

  function commitTyped() {
    const value = Number(typed.replace(',', '.'));
    if (Number.isFinite(value) && value >= 20 && value <= 400) onchange(Math.round(value * 10) / 10);
    else typed = bpm === null ? '' : shown(bpm);
  }

  function step(delta: number) {
    const base = bpm ?? 90;
    onchange(Math.max(20, Math.min(400, Math.round(base + delta))));
  }

  // Tap tempo: the average of the last few intervals; a pause starts over.
  let taps: number[] = [];
  let tapFlash = $state(false);
  function tap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps = [...taps.slice(-6), now];
    tapFlash = true;
    setTimeout(() => (tapFlash = false), 90);
    if (taps.length < 3) return;
    const intervals = taps.slice(1).map((t, i) => t - taps[i]);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    onchange(Math.max(20, Math.min(400, Math.round((60000 / mean) * 10) / 10)), true);
  }

  function detect() {
    detectMessage = ondetect() ? null : 'No steady tempo found in the first track.';
  }

  const sourceText = $derived(
    source === 'detected'
      ? "Detected from the first track's notes."
      : source === 'count-in'
        ? 'The count-in tempo it was recorded with.'
        : source === 'user'
          ? 'Set by you.'
          : 'No tempo yet.',
  );
</script>

<Sheet title="Tempo" {onclose}>
  <div class="tempo">
    <div class="value-row">
      <button class="icon-button step" onclick={() => step(-1)} aria-label="Slower by 1 BPM"><Icon name="minus" /></button>
      <label class="value">
        <input
          id="tempo-value"
          class="tabular"
          type="text"
          inputmode="decimal"
          bind:value={typed}
          placeholder="–"
          aria-label="Tempo in beats per minute"
          onchange={commitTyped}
          onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span>BPM</span>
      </label>
      <button class="icon-button step" onclick={() => step(1)} aria-label="Faster by 1 BPM"><Icon name="plus" /></button>
    </div>

    <input
      class="slider"
      type="range"
      min={MIN}
      max={MAX}
      step="0.5"
      value={bpm ?? 90}
      oninput={(e) => onchange(Number(e.currentTarget.value))}
      aria-label="Tempo"
    />
    <div class="scale tabular" aria-hidden="true"><span>{MIN}</span><span>{MAX}</span></div>

    <div class="by-ear">
      <button class="play" onclick={ontoggleplay} aria-label={playing ? 'Pause' : 'Play with the click'}>
        <Icon name={playing ? 'pause' : 'play'} size={20} />
      </button>
      <button class="pill-button tap" class:flash={tapFlash} onclick={tap}>Tap</button>
      <p class="help">
        Play the sketch: a click sounds on the beat while this is open. Slide until it sits with the music, or tap
        along four or more times.
      </p>
    </div>

    <p class="source">
      {sourceText}
      {#if canDetect}<button class="link" onclick={detect}>Detect again</button>{/if}
      {#if bpm !== null}<button class="link" onclick={onclear}>Clear</button>{/if}
    </p>
    {#if detectMessage}<p class="source warn">{detectMessage}</p>{/if}

    <div class="speed">
      <span>Playback speed</span>
      <div class="segmented" role="group" aria-label="Playback speed">
        {#each [1, 0.75, 0.5] as r (r)}
          <button aria-pressed={rate === r} onclick={() => onrate(r)}>{r}×</button>
        {/each}
      </div>
    </div>

    <button class="pill-button primary done" onclick={onclose}>Done</button>
  </div>
</Sheet>

<style>
  .tempo {
    display: grid;
    gap: 14px;
  }
  .value-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .value {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .value input {
    width: 4.2ch;
    font-size: 2.6rem;
    font-weight: 700;
    text-align: center;
    border: none;
    border-bottom: 2px solid var(--rule-strong);
    background: transparent;
    padding: 0;
  }
  .value input:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }
  .value span {
    color: var(--ink-3);
    font-weight: 600;
  }
  .step {
    border: 1px solid var(--rule);
  }
  .slider {
    width: 100%;
    accent-color: var(--accent);
  }
  .scale {
    display: flex;
    justify-content: space-between;
    margin-top: -10px;
    font-size: 0.72rem;
    color: var(--ink-3);
  }
  .by-ear {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: 10px;
  }
  .play {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
  }
  .tap {
    min-width: 64px;
    justify-content: center;
    transition: background 80ms ease;
  }
  .tap.flash {
    background: var(--accent-soft);
  }
  .help,
  .source {
    margin: 0;
    font-size: 0.82rem;
    color: var(--ink-3);
  }
  .source {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    align-items: baseline;
  }
  .source.warn {
    color: var(--warn);
  }
  .link {
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    font-size: 0.82rem;
  }
  .speed {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 0.9rem;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
  }
  .done {
    justify-self: stretch;
    justify-content: center;
  }
</style>
