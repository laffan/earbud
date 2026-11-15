<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/state/app.svelte';
  import ExportSheet from './lib/ui/ExportSheet.svelte';
  import NotebookView from './lib/ui/NotebookView.svelte';
  import PermissionSheet from './lib/ui/PermissionSheet.svelte';
  import Recorder from './lib/ui/Recorder.svelte';
  import RhythmView from './lib/ui/RhythmView.svelte';
  import SketchView from './lib/ui/SketchView.svelte';
  import Toasts from './lib/ui/Toasts.svelte';

  onMount(() => {
    void app.init();
  });
</script>

<!-- Hidden (not unmounted) while recording so the native preview shows through. -->
<div class="app-main" class:covered={app.recording !== null}>
  {#if app.view.name === 'sketch'}
    {@const id = app.view.id}
    {#key id}
      {#if app.sketches.find((s) => s.id === id)?.kind === 'rhythm'}
        <RhythmView {id} />
      {:else}
        <SketchView {id} />
      {/if}
    {/key}
  {:else}
    <NotebookView />
  {/if}
</div>

{#if app.recording}
  <Recorder recording={app.recording} />
{/if}

{#if app.exportRequest}
  <ExportSheet ids={app.exportRequest} onclose={() => (app.exportRequest = null)} />
{/if}

{#if app.permissionProblem}
  <PermissionSheet problem={app.permissionProblem} />
{/if}

<Toasts />

<style>
  .app-main.covered {
    visibility: hidden;
  }
</style>
