<script lang="ts">
  import { app, type PermissionProblem } from '../state/app.svelte';
  import Sheet from './Sheet.svelte';

  let { problem }: { problem: PermissionProblem } = $props();
  const close = () => (app.permissionProblem = null);
  const what = $derived(
    problem.microphone && problem.camera ? 'the microphone and camera' : problem.microphone ? 'the microphone' : 'the camera',
  );
</script>

<Sheet title="Allow access" onclose={close}>
  <p>Earbud needs {what} to record a sketch. Recordings stay on this device.</p>
  <div class="actions">
    {#if problem.canOpenSettings}
      <button class="pill-button primary" onclick={() => app.openPermissionSettings()}>Open Settings</button>
    {:else}
      <p class="help">Allow access in your system privacy settings, then try again.</p>
    {/if}
    {#if problem.camera && !problem.microphone}
      <button
        class="pill-button"
        onclick={() => {
          app.updateSettings({ camera: 'none' });
          close();
          void app.startRecording();
        }}>Record audio only</button
      >
    {/if}
    <button class="pill-button" onclick={close}>Not now</button>
  </div>
</Sheet>

<style>
  p {
    margin: 0 0 14px;
    color: var(--ink-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .help {
    width: 100%;
    font-size: 0.88rem;
  }
</style>
