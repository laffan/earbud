<script lang="ts">
  /**
   * Full-screen recording overlay. With the native backend the camera preview
   * is drawn by iOS *behind* this (transparent) page; with the web backend we
   * show the MediaStream in a <video>.
   */
  import { onDestroy } from 'svelte';
  import { app, type RecordingState } from '../state/app.svelte';
  import { formatClock } from './format';

  let { recording }: { recording: RecordingState } = $props();

  let now = $state(performance.now());
  const timer = window.setInterval(() => (now = performance.now()), 250);
  onDestroy(() => window.clearInterval(timer));

  const elapsed = $derived(
    recording.phase === 'recording' ? Math.max(recording.elapsedMs, now - recording.startedAt) : 0,
  );
  const counting = $derived(recording.phase === 'recording' && recording.countIn !== null);
  // Map -60…0 dBFS onto 0…1.
  const level = $derived(Math.max(0, Math.min(1, (recording.levelDb + 60) / 60)));
  const peak = $derived(Math.max(0, Math.min(1, (recording.peakDb + 60) / 60)));
  const clipping = $derived(recording.peakDb > -1);

  function srcObject(node: HTMLVideoElement, stream: MediaStream | undefined) {
    node.srcObject = stream ?? null;
    return {
      update(next: MediaStream | undefined) {
        node.srcObject = next ?? null;
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }
</script>

<div class="recorder" class:native={recording.nativePreview} class:audio-only={!recording.hasVideo}>
  {#if !recording.nativePreview && recording.hasVideo && recording.previewStream}
    <video class="preview" use:srcObject={recording.previewStream} autoplay muted playsinline></video>
  {/if}

  {#if !recording.hasVideo}
    <div class="audio-visual" aria-hidden="true">
      <div class="ring" style:transform="scale({0.6 + level * 0.6})"></div>
    </div>
  {/if}

  <div class="top">
    {#if recording.take}<div class="take-label">{recording.take.label}{recording.take.trackId ? ' · new take' : ''}</div>{/if}
    <div class="status">
      {#if recording.phase === 'starting'}
        <span class="label">{recording.retry ? 'Restarting…' : 'Starting…'}</span>
      {:else if recording.phase === 'saving'}
        <span class="label">Saving…</span>
      {:else if counting}
        <span class="label">Count-in</span>
      {:else}
        <span class="dot"></span>
        <span class="clock tabular">{formatClock(elapsed / 1000)}</span>
      {/if}
    </div>
    <div class="meter" class:clipping title="Input level">
      <div class="fill" style:width="{level * 100}%"></div>
      <div class="peak" style:left="{peak * 100}%"></div>
    </div>
    {#if recording.warning}<div class="warning">{recording.warning}</div>{/if}
  </div>

  {#if counting && recording.countIn}
    <div class="count-in" aria-live="assertive">
      {#key recording.countIn.beat}
        <span class="beat tabular">{recording.countIn.beat > 0 ? recording.countIn.beat : ''}</span>
      {/key}
      <span class="beats" aria-hidden="true">
        {#each Array(recording.countIn.beats) as _, i (i)}
          <span class="pip" class:on={i < recording.countIn.beat}></span>
        {/each}
      </span>
    </div>
  {/if}

  <div class="bottom">
    <button
      class="stop"
      onclick={() => app.stopRecording()}
      disabled={recording.phase !== 'recording' || (now < recording.armedAt && !counting)}
      aria-label={counting ? 'Cancel recording' : 'Stop and save'}
    >
      <span class="square"></span>
    </button>
    <p class="hint">
      {#if counting}Get ready. Tap to cancel.{:else if recording.phase === 'recording'}Play. Tap to stop and save.{:else}&nbsp;{/if}
    </p>
  </div>
</div>

<style>
  .recorder {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: #000;
    color: #fff;
    padding: calc(var(--safe-top) + 14px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 20px)
      calc(var(--safe-left) + 16px);
  }
  .recorder.native {
    background: transparent;
  }
  .recorder.audio-only {
    background: var(--paper);
    color: var(--ink);
  }
  .preview {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  .audio-visual {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .ring {
    width: min(60vw, 320px);
    aspect-ratio: 1;
    border-radius: 50%;
    border: 2px solid var(--accent);
    background: var(--accent-soft);
    transition: transform 100ms linear;
  }
  .top,
  .bottom {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 10px;
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 999px;
    background: rgb(0 0 0 / 55%);
    color: #fff;
    font-size: 1.05rem;
    font-weight: 600;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    animation: blink 1.2s steps(2, start) infinite;
  }
  .meter {
    position: relative;
    width: min(70vw, 300px);
    height: 6px;
    border-radius: 3px;
    background: rgb(255 255 255 / 25%);
    overflow: hidden;
  }
  .audio-only .meter {
    background: var(--paper-sunk);
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: #7fd08a;
    transition: width 90ms linear;
  }
  .meter.clipping .fill {
    background: var(--accent);
  }
  .peak {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #fff;
  }
  .take-label {
    padding: 4px 12px;
    border-radius: 999px;
    background: rgb(0 0 0 / 55%);
    color: #fff;
    font-size: 0.85rem;
  }
  .audio-only .take-label {
    background: var(--paper-sunk);
    color: var(--ink-2);
  }
  .count-in {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 18px;
    pointer-events: none;
  }
  .beat {
    font-size: min(38vw, 220px);
    font-weight: 700;
    line-height: 1;
    min-height: 1em;
    color: #fff;
    text-shadow: 0 2px 16px rgb(0 0 0 / 55%);
    animation: beat 240ms ease-out;
  }
  .audio-only .beat {
    color: var(--accent);
    text-shadow: none;
  }
  .beats {
    display: flex;
    gap: 10px;
  }
  .pip {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid currentColor;
    opacity: 0.8;
  }
  .pip.on {
    background: var(--accent);
    border-color: var(--accent);
    opacity: 1;
  }
  @keyframes beat {
    from {
      transform: scale(1.25);
      opacity: 0.4;
    }
  }
  .warning {
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    background: rgb(0 0 0 / 60%);
    color: #ffd27a;
    font-size: 0.9rem;
  }
  .stop {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    border: 3px solid #fff;
    background: rgb(0 0 0 / 35%);
  }
  .audio-only .stop {
    border-color: var(--ink);
    background: var(--paper-raised);
  }
  .square {
    width: 32px;
    height: 32px;
    border-radius: 7px;
    background: var(--accent);
  }
  .hint {
    margin: 0;
    min-height: 1.2em;
    font-size: 0.9rem;
    opacity: 0.85;
    text-shadow: 0 1px 3px rgb(0 0 0 / 60%);
  }
  .audio-only .hint {
    text-shadow: none;
  }
  @keyframes blink {
    to {
      opacity: 0.2;
    }
  }
</style>
