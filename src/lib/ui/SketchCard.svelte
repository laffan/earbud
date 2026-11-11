<script lang="ts">
  import type { Sketch } from '../library/types';
  import type { JobProgress } from '../pipeline/processingQueue';
  import MiniRoll from './MiniRoll.svelte';
  import { displayTitle, formatDuration, formatTimeOfDay } from './format';

  let { sketch, job, onopen }: { sketch: Sketch; job?: JobProgress; onopen: () => void } = $props();

  const status = $derived.by(() => {
    if (sketch.status === 'recording') return { label: 'Recording…', kind: 'accent' };
    if (job) {
      if (job.stage === 'queued') return { label: 'Waiting to transcribe', kind: '' };
      if (job.stage === 'audio') return { label: 'Preparing audio…', kind: '' };
      if (job.stage === 'transcribing') return { label: `Transcribing ${Math.round(job.fraction * 100)}%`, kind: '' };
      return { label: 'Saving…', kind: '' };
    }
    if (sketch.transcriptionStatus === 'failed') return { label: 'Transcription failed', kind: 'warn' };
    if (sketch.transcriptionStatus === 'pending') return { label: 'Not transcribed', kind: '' };
    return null;
  });
</script>

<button class="card" onclick={onopen}>
  <div class="roll">
    {#if sketch.summary && sketch.summary.preview.length > 0}
      <MiniRoll preview={sketch.summary.preview} range={sketch.summary.pitchRange} />
    {:else}
      <div class="roll-empty"></div>
    {/if}
  </div>
  <div class="body">
    <div class="title serif">{displayTitle(sketch)}</div>
    <div class="meta tabular">
      {#if sketch.title.trim()}<span>{formatTimeOfDay(sketch.createdAt)} ·</span>{/if}
      <span>{formatDuration(sketch.durationMs)}</span>
      {#if !sketch.hasVideo}<span>· audio</span>{/if}
      {#if sketch.summary && sketch.summary.noteCount > 0}<span>· {sketch.summary.noteCount} notes</span>{/if}
    </div>
    {#if sketch.summary && sketch.summary.chords.length > 0}
      <div class="chords serif">{sketch.summary.chords.join(' – ')}</div>
    {/if}
    <div class="chips">
      {#if status}<span class="chip {status.kind}">{status.label}</span>{/if}
      {#if sketch.recovered}<span class="chip">Recovered</span>{/if}
      {#if sketch.hasEdits}<span class="chip">Edited</span>{/if}
      {#if sketch.textNotes.trim()}<span class="chip">Notes</span>{/if}
    </div>
  </div>
</button>

<style>
  .card {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 14px;
    width: 100%;
    text-align: left;
    padding: 12px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    align-items: center;
  }
  .card:hover {
    border-color: var(--rule-strong);
  }
  .card:active {
    background: var(--paper-sunk);
  }
  .roll {
    height: 56px;
    display: grid;
    align-items: center;
    padding: 6px;
    border-radius: var(--radius-sm);
    background: var(--paper);
    border: 1px solid var(--rule);
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0 6px,
      color-mix(in srgb, var(--rule) 50%, transparent) 6px 7px
    );
  }
  .roll-empty {
    height: 28px;
  }
  .body {
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .title {
    font-size: 1.08rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 0.82rem;
    color: var(--ink-3);
  }
  .chords {
    font-size: 0.92rem;
    color: var(--chord);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
  }
  .chips:empty {
    display: none;
  }
</style>
