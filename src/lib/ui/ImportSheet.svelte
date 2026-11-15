<script lang="ts">
  /**
   * Import a file as a new sketch where the canvas was pressed: an audio
   * file (a recording, transcribed like a take) or a MIDI file (its notes,
   * played by the built-in piano).
   */
  import { AUDIO_ACCEPT, MIDI_ACCEPT } from '../library/importTrack';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  interface Props {
    onimport: (kind: 'midi' | 'audio', file: File) => Promise<boolean>;
    onclose: () => void;
  }

  let { onimport, onclose }: Props = $props();

  let busy = $state<string | null>(null);

  async function picked(kind: 'midi' | 'audio', input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    busy = file.name;
    const ok = await onimport(kind, file);
    busy = null;
    if (ok) onclose();
  }
</script>

<Sheet title="Import audio" onclose={() => !busy && onclose()}>
  <div class="import">
    <div class="choices">
      <label class="choice" class:disabled={busy}>
        <input type="file" accept={AUDIO_ACCEPT} disabled={!!busy} onchange={(e) => picked('audio', e.currentTarget)} />
        <span class="icon"><Icon name="mic" /></span>
        <span class="text">
          <strong>Audio file</strong>
          <span>A recording (or a video's sound), transcribed like a take</span>
        </span>
      </label>
      <label class="choice" class:disabled={busy}>
        <input type="file" accept={MIDI_ACCEPT} disabled={!!busy} onchange={(e) => picked('midi', e.currentTarget)} />
        <span class="icon"><Icon name="import" /></span>
        <span class="text">
          <strong>MIDI file</strong>
          <span>Its notes as they are, played by the built-in piano (.mid)</span>
        </span>
      </label>
    </div>

    {#if busy}
      <p class="busy" aria-live="polite">Importing {busy}…</p>
    {:else}
      <p class="help">It goes where you pressed. The file is copied in; the original is not changed.</p>
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
