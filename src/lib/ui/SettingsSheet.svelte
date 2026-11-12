<script lang="ts">
  import { app } from '../state/app.svelte';
  import Sheet from './Sheet.svelte';
  import WatchSettings from './WatchSettings.svelte';
  import type { CameraChoice, LensChoice } from '../capture/types';
  import type { Sensitivity } from '../transcription';

  let { onclose }: { onclose: () => void } = $props();

  let diagnostics = $state<string | null>(null);
  let copied = $state(false);

  async function showDiagnostics() {
    diagnostics = 'Loading…';
    diagnostics = await app.captureDiagnostics();
  }

  async function copyDiagnostics() {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(diagnostics);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      app.toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }
  const native = $derived(app.capabilities?.nativeCapture ?? false);

  const cameras: { value: CameraChoice; label: string }[] = [
    { value: 'back', label: 'Back' },
    { value: 'front', label: 'Front' },
    { value: 'none', label: 'Audio only' },
  ];
  const lenses: { value: LensChoice; label: string }[] = [
    { value: 'wide', label: 'Wide' },
    { value: 'ultraWide', label: 'Ultra wide' },
  ];
  const sensitivities: { value: Sensitivity; label: string }[] = [
    { value: 'conservative', label: 'Fewer notes' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'sensitive', label: 'More notes' },
  ];
</script>

<Sheet title="Settings" {onclose}>
  <section>
    <h3>Camera</h3>
    <div class="segmented" role="group" aria-label="Camera">
      {#each cameras as c (c.value)}
        <button aria-pressed={app.settings.camera === c.value} onclick={() => app.updateSettings({ camera: c.value })}
          >{c.label}</button
        >
      {/each}
    </div>
    {#if native && app.settings.camera === 'back'}
      <div class="segmented" role="group" aria-label="Lens">
        {#each lenses as l (l.value)}
          <button aria-pressed={app.settings.lens === l.value} onclick={() => app.updateSettings({ lens: l.value })}
            >{l.label}</button
          >
        {/each}
      </div>
      <p class="help">Ultra wide fits the whole keyboard when the phone is close to the keys.</p>
    {/if}
  </section>

  {#if native}
    <section>
      <label class="toggle">
        <input
          type="checkbox"
          checked={app.settings.rawAudio}
          onchange={(e) => app.updateSettings({ rawAudio: e.currentTarget.checked })}
        />
        <span>
          <strong>Unprocessed microphone</strong>
          <span class="help">Turns off iOS voice processing for a more faithful piano sound. Quieter.</span>
        </span>
      </label>
    </section>
  {/if}

  <section>
    <h3>Transcription</h3>
    <div class="segmented" role="group" aria-label="Sensitivity">
      {#each sensitivities as s (s.value)}
        <button
          aria-pressed={app.settings.sensitivity === s.value}
          onclick={() => app.updateSettings({ sensitivity: s.value })}>{s.label}</button
        >
      {/each}
    </div>
    <label class="toggle">
      <input
        type="checkbox"
        checked={app.settings.autoTranscribe}
        onchange={(e) => app.updateSettings({ autoTranscribe: e.currentTarget.checked })}
      />
      <span><strong>Transcribe automatically</strong></span>
    </label>
  </section>

  {#if app.watch}
    <WatchSettings watch={app.watch} />
  {/if}

  <section>
    <h3>Diagnostics</h3>
    {#if diagnostics === null}
      <button class="pill-button" onclick={showDiagnostics}>Show diagnostics log</button>
      <p class="help">Recent recording, playback and Apple Watch events, useful when reporting a problem.</p>
    {:else}
      <div class="diag-actions">
        <button class="pill-button" onclick={copyDiagnostics}>{copied ? 'Copied' : 'Copy'}</button>
        <button class="pill-button" onclick={showDiagnostics}>Refresh</button>
      </div>
      <pre class="diag">{diagnostics}</pre>
    {/if}
  </section>

  <section class="about">
    <p>
      Everything stays on this device. Recordings are never modified; transcriptions and edits are stored beside
      them. Transcription uses Spotify's Basic Pitch model and runs offline.
    </p>
    {#if !app.library.persistent}
      <p class="warn">Browser preview: sketches are kept in memory and disappear on reload.</p>
    {/if}
  </section>
</Sheet>

<style>
  section {
    display: grid;
    gap: 10px;
    padding: 12px 0;
    border-top: 1px solid var(--rule);
    justify-items: start;
  }
  h3 {
    margin: 0;
    font-size: 0.8rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .help {
    display: block;
    margin: 0;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .toggle {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .toggle input {
    margin-top: 4px;
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }
  .about p {
    margin: 0;
    font-size: 0.88rem;
    color: var(--ink-2);
  }
  .warn {
    color: var(--warn) !important;
  }
  .diag-actions {
    display: flex;
    gap: 8px;
  }
  .diag {
    width: 100%;
    max-height: 40vh;
    overflow: auto;
    margin: 0;
    padding: 10px;
    border-radius: var(--radius-sm);
    background: var(--paper-sunk);
    font-family: var(--font-mono);
    font-size: 0.72rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    -webkit-user-select: text;
  }
</style>
