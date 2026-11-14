<script lang="ts">
  /**
   * A track's chords, in a strip between its piano roll and its waveform.
   * It scrolls and zooms with the roll (the shared `RollViewport`), keeping
   * the roll's keyboard margin, so each chord sits under the notes that make
   * it. The chord at the playhead is lit. Tap a chord to hear it.
   */
  import type { ChordSegment } from '../music/chords';
  import { ROLL_GUTTER, type RollViewport } from './rollViewport.svelte';

  interface Props {
    chords: ChordSegment[];
    /** Where the chords' time 0 lies in sketch time (seconds). */
    offset: number;
    /** Sketch time (seconds). */
    currentTime: number;
    view: RollViewport;
    /** Display symbol of a chord (spelled for the sketch's key). */
    spell?: (chord: ChordSegment) => string;
    /** Shown when there are no chords. */
    empty?: string;
    onchordtap?: (chord: ChordSegment) => void;
  }

  let { chords, offset, currentTime, view, spell = (c) => c.symbol, empty = 'No chords found', onchordtap }: Props = $props();

  let laneWidth = $state(0);
  const now = $derived(currentTime - offset);

  /** The chords in view, with their place in the lane (px). */
  const visible = $derived.by(() => {
    const out: { chord: ChordSegment; left: number; width: number; active: boolean }[] = [];
    for (const chord of chords) {
      const left = (chord.startTime + offset - view.scrollX) * view.pxPerSec;
      const width = (chord.endTime - chord.startTime) * view.pxPerSec;
      if (left + width < 0 || left > laneWidth) continue;
      // A chord that began before the left edge keeps its name in view.
      const from = Math.max(0, left);
      out.push({ chord, left: from, width: left + width - from, active: now >= chord.startTime && now < chord.endTime });
    }
    return out;
  });
</script>

<div class="chord-strip" style:--gutter="{ROLL_GUTTER}px">
  <span class="gutter" aria-hidden="true">Chords</span>
  <div class="lane" bind:clientWidth={laneWidth} role="group" aria-label="Chords">
    {#each visible as { chord, left, width, active } (chord.startTime)}
      <button
        class="chord serif"
        class:active
        style:left="{left}px"
        style:width="{Math.max(2, width - 3)}px"
        title="{spell(chord)} — tap to hear"
        aria-label="{spell(chord)}, play it"
        onclick={() => onchordtap?.(chord)}><span>{spell(chord)}</span></button
      >
    {/each}
    {#if chords.length === 0}<span class="empty">{empty}</span>{/if}
  </div>
</div>

<style>
  .chord-strip {
    display: flex;
    height: 34px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper-raised);
    min-width: 0;
  }
  .gutter {
    flex: none;
    width: var(--gutter);
    display: grid;
    place-items: center;
    font-size: 0.56rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
    border-right: 1px solid var(--rule);
  }
  .lane {
    position: relative;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .chord {
    position: absolute;
    top: 4px;
    bottom: 4px;
    display: flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--chord) 12%, transparent);
    border-left: 2px solid color-mix(in srgb, var(--chord) 55%, transparent);
    color: var(--chord);
    font-weight: 700;
    font-size: 0.86rem;
    overflow: hidden;
    white-space: nowrap;
    touch-action: pan-y;
  }
  .chord span {
    overflow: hidden;
    text-overflow: clip;
  }
  .chord.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
    color: var(--accent);
  }
  .chord:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    padding-left: 10px;
    font-size: 0.78rem;
    color: var(--ink-3);
  }
</style>
