<script lang="ts">
  /**
   * Settings → Audio: the microphone and the output, chosen separately.
   * In a browser or desktop web view, any listed device (the output only
   * where the web view can route Web Audio). On iOS, the kind of microphone
   * and speaker or automatic output while recording, as far as iOS allows.
   */
  import { onDestroy, onMount } from 'svelte';
  import { canChooseInput, canChooseOutput, listAudioDevices, revealDeviceNames, type AudioDevice, type IosInput, type IosOutput } from '../audio/devices';
  import { NoteSynth } from '../music/synth';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';

  let { native }: { native: boolean } = $props();

  let inputs = $state<AudioDevice[]>([]);
  let outputs = $state<AudioDevice[]>([]);
  let named = $state(true);
  const outputChoosable = canChooseOutput();

  async function refresh() {
    if (native || !canChooseInput()) return;
    try {
      const found = await listAudioDevices();
      inputs = found.inputs;
      outputs = found.outputs;
      named = found.named;
    } catch (error) {
      app.logCapture(`[audio] could not list devices: ${errorMessage(error)}`);
    }
  }

  async function showNames() {
    try {
      await revealDeviceNames();
    } catch (error) {
      app.toast(`Could not use the microphone: ${errorMessage(error)}`, 'error');
    }
    await refresh();
  }

  onMount(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
  });
  onDestroy(() => {
    navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
    tester?.dispose();
  });

  /** A short chord through the chosen output. */
  let tester: NoteSynth | null = null;
  function test() {
    tester ??= new NoteSynth();
    tester.unlock();
    tester.playChord([60, 64, 67, 72], 80, 1.2, 0.03);
  }

  /** A chosen device that is not connected now is still shown, so the choice is not lost silently. */
  const missingInput = $derived(app.settings.audioInput && !inputs.some((d) => d.id === app.settings.audioInput));
  const missingOutput = $derived(app.settings.audioOutput && !outputs.some((d) => d.id === app.settings.audioOutput));

  const iosInputs: { value: IosInput; label: string }[] = [
    { value: 'auto', label: 'Automatic' },
    { value: 'builtIn', label: 'Built-in' },
    { value: 'bluetooth', label: 'Bluetooth' },
    { value: 'wired', label: 'Headset or USB' },
  ];
  const iosOutputs: { value: IosOutput; label: string }[] = [
    { value: 'auto', label: 'Automatic' },
    { value: 'speaker', label: 'Speaker' },
  ];
</script>

<section class="audio">
  <h3>Audio</h3>
  {#if native}
    <div class="row">
      <span class="label">Microphone</span>
      <div class="segmented" role="group" aria-label="Microphone">
        {#each iosInputs as o (o.value)}
          <button aria-pressed={app.settings.iosInput === o.value} onclick={() => app.updateSettings({ iosInput: o.value })}>{o.label}</button>
        {/each}
      </div>
    </div>
    <div class="row">
      <span class="label">Sound while recording</span>
      <div class="segmented" role="group" aria-label="Output while recording">
        {#each iosOutputs as o (o.value)}
          <button aria-pressed={app.settings.iosOutput === o.value} onclick={() => app.updateSettings({ iosOutput: o.value })}>{o.label}</button>
        {/each}
      </div>
    </div>
    {#if app.settings.iosInput === 'bluetooth' && app.settings.iosOutput === 'speaker'}
      <p class="help warn">
        iOS plays through the headset whose microphone is in use: with a Bluetooth microphone the sound stays in the
        headset, not the speaker.
      </p>
    {:else}
      <p class="help">
        Automatic output plays through headphones when they are connected, otherwise the speaker. The built-in or a
        wired microphone can record while Bluetooth headphones play. A choice that is not connected falls back to what
        iOS picks. Outside recording, iOS chooses the output (Control Center).
      </p>
    {/if}
  {:else if canChooseInput()}
    <label class="row">
      <span class="label">Microphone</span>
      <select value={app.settings.audioInput} onchange={(e) => app.updateSettings({ audioInput: e.currentTarget.value })}>
        <option value="">System default</option>
        {#each inputs as d (d.id)}<option value={d.id}>{d.label}</option>{/each}
        {#if missingInput}<option value={app.settings.audioInput}>Chosen microphone (not connected)</option>{/if}
      </select>
    </label>
    <label class="row">
      <span class="label">Output</span>
      {#if outputChoosable}
        <select value={app.settings.audioOutput} onchange={(e) => app.updateSettings({ audioOutput: e.currentTarget.value })}>
          <option value="">System default</option>
          {#each outputs as d (d.id)}<option value={d.id}>{d.label}</option>{/each}
          {#if missingOutput}<option value={app.settings.audioOutput}>Chosen output (not connected)</option>{/if}
        </select>
      {:else}
        <span class="fixed">The system's output</span>
      {/if}
    </label>
    <div class="actions">
      <button class="pill-button" onclick={test}>Play a test sound</button>
      {#if !named}<button class="pill-button" onclick={showNames}>Show device names</button>{/if}
    </div>
    <p class="help">
      {#if outputChoosable}
        Playback, the count-in and the pads play through the output; recordings come from the microphone.
      {:else}
        This web view cannot send sound to a chosen output; it plays through the system's output (choose it in the
        system's sound settings).
      {/if}
    </p>
  {:else}
    <p class="help">This web view cannot choose audio devices.</p>
  {/if}
</section>

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
  .row {
    display: grid;
    gap: 6px;
    width: 100%;
  }
  .label {
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  select {
    width: 100%;
    max-width: 420px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule-strong);
    background: var(--paper);
  }
  .fixed {
    font-size: 0.9rem;
    color: var(--ink-3);
  }
  .segmented {
    flex-wrap: wrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .help {
    margin: 0;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .warn {
    color: var(--warn);
  }
</style>
