<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from './lib/state/app.svelte';
  import Home from './lib/ui/Home.svelte';
  import PermissionSheet from './lib/ui/PermissionSheet.svelte';
  import Recorder from './lib/ui/Recorder.svelte';
  import SketchView from './lib/ui/SketchView.svelte';
  import Toasts from './lib/ui/Toasts.svelte';

  onMount(() => {
    void app.init();
  });
</script>

<!-- Hidden (not unmounted) while recording so the native preview shows through. -->
<div class="app-main" class:covered={app.recording !== null}>
  {#if app.view.name === 'sketch'}
    {#key app.view.id}
      <SketchView id={app.view.id} />
    {/key}
  {:else}
    <Home />
  {/if}
</div>

{#if app.recording}
  <Recorder recording={app.recording} />
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
