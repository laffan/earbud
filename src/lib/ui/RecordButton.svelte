<script lang="ts">
  let { onclick, disabled = false, busy = false }: { onclick: () => void; disabled?: boolean; busy?: boolean } =
    $props();
</script>

<button class="record" {onclick} {disabled} aria-label="Record a new sketch" class:busy>
  <span class="dot"></span>
</button>

<style>
  .record {
    width: 84px;
    height: 84px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--paper-raised);
    border: 3px solid var(--ink);
    box-shadow: var(--shadow);
    transition: transform 120ms ease;
  }
  .record:active:not(:disabled) {
    transform: scale(0.94);
  }
  .dot {
    width: 62px;
    height: 62px;
    border-radius: 50%;
    background: var(--accent);
    transition: all 160ms ease;
  }
  .busy .dot {
    width: 30px;
    height: 30px;
    border-radius: 7px;
    animation: pulse 1s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.5;
    }
  }
</style>
