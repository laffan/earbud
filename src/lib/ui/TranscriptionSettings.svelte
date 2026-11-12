<script lang="ts">
  /**
   * Where the take was recorded and how held notes are treated. Used in
   * Settings and in a sketch's "Transcribe again" sheet; both edit the same
   * app settings, which apply to the next transcription.
   */
  import { app } from '../state/app.svelte';
  import { ENVIRONMENTS, type Environment, type HeldNotes, type NoiseSettings } from '../transcription/settings';

  const environments: { value: Environment; label: string; help: string }[] = [
    {
      value: 'quiet',
      label: 'Quiet',
      help: 'Keeps every note the model hears. Best when the piano is the only sound in the room.',
    },
    {
      value: 'room',
      label: 'Normal',
      help: 'Ignores sounds that are far quieter than the piano.',
    },
    {
      value: 'noisy',
      label: 'Noisy',
      help: 'For talking, a TV or traffic in the background: keeps only notes that are struck, reasonably loud and not very short. Can drop very soft or very fast notes.',
    },
    { value: 'custom', label: 'Custom', help: 'Set each filter yourself.' },
  ];
  const held: { value: HeldNotes; label: string; help: string }[] = [
    { value: 'off', label: 'As detected', help: 'Notes are left the way the model cut them.' },
    {
      value: 'join',
      label: 'Join',
      help: 'A note that drops out and comes back while other notes are played over it becomes one long note.',
    },
    {
      value: 'strong',
      label: 'Join more',
      help: 'Also joins when another key (often its octave) re-triggers the held note. Can join a softly repeated note.',
    },
  ];

  const settings = $derived(app.settings.transcription);
  const environment = $derived(environments.find((e) => e.value === settings.environment) ?? environments[1]);
  const heldChoice = $derived(held.find((h) => h.value === settings.heldNotes) ?? held[1]);
  const custom = $derived(settings.custom);

  function chooseEnvironment(value: Environment) {
    if (value === 'custom' && settings.environment !== 'custom') {
      // Start the sliders from the profile that was in use.
      app.updateTranscription({ environment: value, custom: { ...ENVIRONMENTS[settings.environment] } });
    } else {
      app.updateTranscription({ environment: value });
    }
  }

  function setCustom(patch: Partial<NoiseSettings>) {
    app.updateTranscription({ custom: { ...custom, ...patch } });
  }
</script>

<div class="group">
  <span class="label" id="environment-label">Recorded in a room that is</span>
  <div class="segmented" role="group" aria-labelledby="environment-label">
    {#each environments as e (e.value)}
      <button aria-pressed={settings.environment === e.value} onclick={() => chooseEnvironment(e.value)}>{e.label}</button>
    {/each}
  </div>
  <p class="help">{environment.help}</p>

  {#if settings.environment === 'custom'}
    <div class="custom">
      <label class="toggle">
        <input
          type="checkbox"
          checked={custom.noiseGateDb !== null}
          onchange={(e) => setCustom({ noiseGateDb: e.currentTarget.checked ? 24 : null })}
        />
        <span><strong>Ignore quiet sounds</strong></span>
      </label>
      {#if custom.noiseGateDb !== null}
        <label class="slider">
          <span>More than <b class="tabular">{custom.noiseGateDb} dB</b> below the piano's loud notes</span>
          <input
            type="range"
            min="10"
            max="40"
            step="1"
            value={custom.noiseGateDb}
            oninput={(e) => setCustom({ noiseGateDb: Number(e.currentTarget.value) })}
          />
          <span class="ends"><span>removes more</span><span>removes less</span></span>
        </label>
      {/if}

      <label class="toggle">
        <input
          type="checkbox"
          checked={custom.requireStrike}
          onchange={(e) => setCustom({ requireStrike: e.currentTarget.checked })}
        />
        <span>
          <strong>Only notes that begin with a key strike</strong>
          <span class="help">Sounds that swell in without an attack (voices, hum) are dropped.</span>
        </span>
      </label>
      {#if custom.requireStrike}
        <label class="slider">
          <span>How clear the strike must be: <b class="tabular">{custom.strikeOnset.toFixed(2)}</b></span>
          <input
            type="range"
            min="0.3"
            max="0.9"
            step="0.05"
            value={custom.strikeOnset}
            oninput={(e) => setCustom({ strikeOnset: Number(e.currentTarget.value) })}
          />
          <span class="ends"><span>keeps more</span><span>removes more</span></span>
        </label>
      {/if}

      <label class="slider">
        <span>Shortest note kept: <b class="tabular">{Math.round(custom.minNoteLengthMs)} ms</b></span>
        <input
          type="range"
          min="60"
          max="300"
          step="10"
          value={Math.round(custom.minNoteLengthMs / 10) * 10}
          oninput={(e) => setCustom({ minNoteLengthMs: Number(e.currentTarget.value) })}
        />
        <span class="ends"><span>keeps fast notes</span><span>removes blips</span></span>
      </label>
    </div>
  {/if}
</div>

<div class="group">
  <span class="label" id="held-label">Held notes</span>
  <div class="segmented" role="group" aria-labelledby="held-label">
    {#each held as h (h.value)}
      <button aria-pressed={settings.heldNotes === h.value} onclick={() => app.updateTranscription({ heldNotes: h.value })}
        >{h.label}</button
      >
    {/each}
  </div>
  <p class="help">{heldChoice.help}</p>
</div>

<style>
  .group {
    display: grid;
    gap: 8px;
    justify-items: start;
    width: 100%;
  }
  .label {
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  .help {
    display: block;
    margin: 0;
    font-size: 0.85rem;
    color: var(--ink-3);
  }
  .segmented {
    max-width: 100%;
  }
  .custom {
    display: grid;
    gap: 12px;
    width: 100%;
    padding: 12px;
    border-radius: var(--radius-sm);
    background: var(--paper-sunk);
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
    flex: none;
    accent-color: var(--accent);
  }
  .slider {
    display: grid;
    gap: 4px;
    font-size: 0.88rem;
    color: var(--ink-2);
  }
  .slider input {
    width: 100%;
    accent-color: var(--accent);
  }
  .ends {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: var(--ink-3);
  }
</style>
