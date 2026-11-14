<script lang="ts">
  /**
   * Import a track: a MIDI file (its notes, played by the built-in piano)
   * or an audio file (a recording, transcribed like a take), starting at
   * the start of the sketch or at the playhead.
   */
  import { AUDIO_ACCEPT, MIDI_ACCEPT } from '../library/importTrack';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import { formatClock } from './format';

  interface Props {
    /** Where the sketch's playing starts (after the first track's count-in), seconds. */
    start: number;
    playhead: number;
    onimport: (kind: 'midi' | 'audio', file: File, offsetMs: number) => Promise<boolean>;
    onclose: () => void;
  }

  let { start, playhead, onimport, onclose }: Props = $props();

  let at = $state<'start' | 'playhead'>('start');
  let busy = $state<string | null>(null);
  /** The playhead is somewhere other than the start, so it is a real choice. */
  const offerPlayhead = $derived(Math.abs(playhead - start) > 0.05);

  async function picked(kind: 'midi' | 'audio', input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = file.name;
    const offset = at === 'playhead' && offerPlayhead ? playhead : start;
    const ok = await onimport(kind, file, Math.round(offset * 1000));
    busy = null;
    if (ok) onclose();
  }
</script>

<Sheet title="Import a track" onclose={() => !busy && onclose()}>
  <div class="import">
    <div class="choices">
      <label class="choice" class:disabled={busy}>
        <input type="file" accept={MIDI_ACCEPT} disabled={!!busy} onchange={(e) => picked('midi', e.currentTarget)} />
        <span class="icon"><Icon name="import" /></span>
        <span class="text">
          <strong>MIDI file</strong>
          <span>Its notes as they are, played by the built-in piano (.mid)</span>
        </span>
      </label>
      <label class="choice" class:disabled={busy}>
        <input type="file" accept={AUDIO_ACCEPT} disabled={!!busy} onchange={(e) => picked('audio', e.currentTarget)} />
        <span class="icon"><Icon name="mic" /></span>
        <span class="text">
          <strong>Audio file</strong>
          <span>A recording (or a video's sound), transcribed like a take</span>
        </span>
      </label>
    </div>

    {#if offerPlayhead}
      <div class="start">
        <span>Starts</span>
        <div class="segmented" role="group" aria-label="Where the track starts">
          <button aria-pressed={at === 'start'} onclick={() => (at = 'start')} disabled={!!busy}>At the start</button>
          <button aria-pressed={at === 'playhead'} onclick={() => (at = 'playhead')} disabled={!!busy}
            >At the playhead ({formatClock(playhead)})</button
          >
        </div>
      </div>
    {/if}

    {#if busy}
      <p class="busy" aria-live="polite">Importing {busy}…</p>
    {:else}
      <p class="help">The file is copied into the sketch; the original is not changed. Use a track's ⋯ → Line up to adjust where it sits.</p>
    {/if}
  </div>
</Sheet>

<style>
  .import {
    display: grid;
    gap: 14px;
  }
  .choices {
    display: grid;
    gap: 8px;
  }
  .choice {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    cursor: pointer;
  }
  .choice:hover:not(.disabled) {
    background: var(--paper-sunk);
  }
  .choice.disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* The input covers nothing and is not displayed: the label opens its picker. */
  .choice input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .choice:focus-within {
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .icon {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--paper-sunk);
    color: var(--ink-2);
  }
  .text {
    display: grid;
    gap: 2px;
  }
  .text span {
    font-size: 0.82rem;
    color: var(--ink-3);
  }
  .start {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
    font-size: 0.9rem;
  }
  .start .segmented button {
    padding: 0 10px;
    font-size: 0.82rem;
  }
  .help,
  .busy {
    margin: 0;
    font-size: 0.82rem;
    color: var(--ink-3);
  }
  .busy {
    color: var(--ink-2);
  }
</style>
