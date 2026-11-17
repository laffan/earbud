<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/state/app.svelte';
  import ExportSheet from './lib/ui/ExportSheet.svelte';
  import NotebookView from './lib/ui/NotebookView.svelte';
  import PermissionSheet from './lib/ui/PermissionSheet.svelte';
  import Recorder from './lib/ui/Recorder.svelte';
  import ReferenceView from './lib/ui/ReferenceView.svelte';
  import SampleLibraryView from './lib/ui/SampleLibraryView.svelte';
  import RhythmView from './lib/ui/RhythmView.svelte';
  import SketchView from './lib/ui/SketchView.svelte';
  import Toasts from './lib/ui/Toasts.svelte';
  import { blockPageZoom, installSpaceBar } from './lib/ui/transport';

  onMount(() => {
    void app.init();
    // The space bar plays and pauses what is in front; only the canvas and piano rolls zoom.
    const removeSpace = installSpaceBar();
    const removeZoom = blockPageZoom();
    return () => {
      removeSpace();
      removeZoom();
    };
  });
</script>

<!-- Hidden (not unmounted) while recording so the native preview shows through. -->
<!-- A recording onto the canvas happens in place (a strip on the canvas); others cover the screen. -->
<div class="app-main" class:covered={app.recording !== null && !app.recording.canvas}>
  {#if app.view.name === 'sketch'}
    {@const id = app.view.id}
    {#key id}
      {#if app.sketches.find((s) => s.id === id)?.kind === 'rhythm'}
        <RhythmView {id} />
      {:else}
        <SketchView {id} />
      {/if}
    {/key}
  {:else if app.view.name === 'reference'}
    <ReferenceView />
  {:else if app.view.name === 'samples'}
    <SampleLibraryView />
  {:else}
    <NotebookView />
  {/if}
</div>

{#if app.recording && !app.recording.canvas}
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
