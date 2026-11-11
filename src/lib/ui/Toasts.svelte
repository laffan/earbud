<script lang="ts">
  import { app } from '../state/app.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class="toast" class:error={toast.kind === 'error'}>
      <span>{toast.message}</span>
      {#if toast.action}
        <button
          onclick={() => {
            toast.action?.run();
            app.dismissToast(toast.id);
          }}>{toast.action.label}</button
        >
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    top: calc(var(--safe-top) + 12px);
    z-index: 60;
    display: grid;
    gap: 8px;
    width: min(92vw, 440px);
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--ink);
    color: var(--paper);
    font-size: 0.9rem;
    box-shadow: var(--shadow);
  }
  .toast.error {
    background: var(--accent);
    color: var(--accent-ink);
  }
  .toast button {
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
