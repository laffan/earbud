<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, onclose, children }: { title: string; onclose: () => void; children: Snippet } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" role="presentation" onclick={onclose}></div>
<div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
  <div class="grabber"></div>
  <h2 class="serif">{title}</h2>
  {@render children()}
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(20 15 5 / 35%);
    z-index: 40;
    animation: fade 140ms ease;
  }
  .sheet {
    position: fixed;
    z-index: 41;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    width: min(100vw, 560px);
    max-height: 88vh;
    overflow-y: auto;
    background: var(--paper-raised);
    border-radius: 20px 20px 0 0;
    padding: 10px calc(20px + var(--safe-right)) calc(24px + var(--safe-bottom)) calc(20px + var(--safe-left));
    box-shadow: var(--shadow);
    animation: rise 180ms ease;
  }
  .grabber {
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: var(--rule-strong);
    margin: 0 auto 10px;
  }
  h2 {
    margin: 0 0 14px;
    font-size: 1.25rem;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      transform: translate(-50%, 30px);
      opacity: 0;
    }
  }
</style>
