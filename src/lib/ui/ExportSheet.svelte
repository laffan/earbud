<script lang="ts">
  /** Pick what to share (video, take audio, notes audio, MIDI), then share. */
  import { deliverExports, prepareExports, recordingExtension } from '../export/exporter';
  import type { ExportKind } from '../library/types';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';
  import { displayTitle } from './format';

  let { ids, onclose }: { ids: string[]; onclose: () => void } = $props();

  const STORAGE_KEY = 'earbud.export.kinds.v1';
  const sketches = $derived(app.sketches.filter((s) => ids.includes(s.id)));
  const allVideo = $derived(sketches.length > 0 && sketches.every((s) => s.hasVideo));
  const anyTranscribed = $derived(sketches.some((s) => s.transcriptionStatus === 'done'));
  const someUntranscribed = $derived(sketches.some((s) => s.transcriptionStatus !== 'done'));
  const native = $derived(app.capabilities?.nativeShare ?? false);
  const audioExt = $derived(app.capabilities?.nativeAudioExport ? 'm4a' : 'wav');
  const recordingExt = $derived(
    [...new Set(sketches.map((s) => recordingExtension(s.mediaMime)))].map((e) => `.${e}`).join(', ') || '.mov',
  );

  function loadSelection(): ExportKind[] {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      if (Array.isArray(saved)) return saved as ExportKind[];
    } catch {
      // ignore
    }
    return ['recording', 'midi'];
  }

  let selected = $state<ExportKind[]>(loadSelection());
  let busy = $state(false);
  let progress = $state<{ message: string; fraction: number } | null>(null);

  const options = $derived<{ kind: ExportKind; label: string; detail: string; disabled: boolean }[]>([
    {
      kind: 'recording',
      label: allVideo ? 'Video' : 'Recording',
      detail: `The original take, untouched (${recordingExt})`,
      disabled: false,
    },
    { kind: 'audio', label: 'Recorded audio', detail: `The take's sound on its own (.${audioExt})`, disabled: false },
    {
      kind: 'notes-audio',
      label: 'Notes audio',
      detail: 'The transcribed notes played by the built-in piano (.wav)',
      disabled: !anyTranscribed,
    },
    { kind: 'midi', label: 'MIDI', detail: 'The transcribed notes, with your edits (.mid)', disabled: !anyTranscribed },
  ]);

  const effective = $derived(selected.filter((k) => !options.find((o) => o.kind === k)?.disabled));

  function toggle(kind: ExportKind) {
    selected = selected.includes(kind) ? selected.filter((k) => k !== kind) : [...selected, kind];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // ignore
    }
  }

  async function share() {
    if (busy || effective.length === 0) return;
    busy = true;
    try {
      const prepared = await prepareExports(ids, effective, app.exportDeps(), (message, fraction) => {
        progress = { message, fraction };
      });
      for (const note of prepared.skipped) app.toast(note, 'error');
      const outcome = await deliverExports(prepared.files, app.capabilities);
      if (outcome && !native) app.toast(outcome);
      onclose();
    } catch (error) {
      app.toast(`Export failed: ${errorMessage(error)}`, 'error');
    } finally {
      busy = false;
      progress = null;
    }
  }
</script>

<Sheet title={sketches.length === 1 ? `Share “${displayTitle(sketches[0])}”` : `Share ${sketches.length} sketches`} {onclose}>
  <div class="options" role="group" aria-label="Files to include">
    {#each options as option (option.kind)}
      <label class="option" class:disabled={option.disabled}>
        <input
          type="checkbox"
          checked={effective.includes(option.kind)}
          disabled={option.disabled || busy}
          onchange={() => toggle(option.kind)}
        />
        <span class="text">
          <span class="label">{option.label}</span>
          <span class="detail">{option.detail}</span>
        </span>
      </label>
    {/each}
  </div>
  {#if anyTranscribed && someUntranscribed}
    <p class="note">Notes audio and MIDI are left out for sketches that are not transcribed yet.</p>
  {:else if !anyTranscribed}
    <p class="note">Notes audio and MIDI become available once the sketch is transcribed.</p>
  {/if}

  {#if progress}
    <div class="progress" aria-live="polite">
      <span>{progress.message}</span>
      <div class="bar"><div style:width="{Math.round(progress.fraction * 100)}%"></div></div>
    </div>
  {/if}

  <div class="actions">
    <button class="pill-button primary" onclick={share} disabled={busy || effective.length === 0}>
      <Icon name="share" size={16} />
      {busy ? 'Preparing…' : native ? 'Share' : app.capabilities?.tauri ? 'Export…' : 'Download'}
    </button>
    <button class="pill-button" onclick={onclose} disabled={busy}>Cancel</button>
  </div>
</Sheet>

<style>
  .options {
    display: grid;
    gap: 2px;
    margin-bottom: 8px;
  }
  .option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 10px 4px;
    border-bottom: 1px solid var(--rule);
    cursor: pointer;
  }
  .option.disabled {
    opacity: 0.45;
    cursor: default;
  }
  .option input {
    margin-top: 3px;
    width: 20px;
    height: 20px;
    flex: none;
    accent-color: var(--accent);
  }
  .text {
    display: grid;
    gap: 1px;
  }
  .label {
    font-weight: 600;
  }
  .detail,
  .note {
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .note {
    margin: 6px 0 10px;
  }
  .progress {
    display: grid;
    gap: 6px;
    margin: 6px 0 12px;
    font-size: 0.88rem;
    color: var(--ink-2);
  }
  .bar {
    height: 4px;
    border-radius: 2px;
    background: var(--rule);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--note);
    transition: width 200ms ease;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
</style>
