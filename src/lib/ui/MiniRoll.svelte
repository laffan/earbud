<script lang="ts">
  /** Tiny piano-roll thumbnail drawn from a sketch summary. */
  let { preview, range }: { preview: [number, number, number][]; range: [number, number] | null } = $props();

  const end = $derived(preview.reduce((t, n) => Math.max(t, n[2]), 0.001));
  const lo = $derived((range?.[0] ?? 48) - 1);
  const hi = $derived((range?.[1] ?? 72) + 1);
  const span = $derived(Math.max(12, hi - lo));
</script>

<svg class="mini" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
  {#each preview as [pitch, start, stop], i (i)}
    <rect
      x={(start / end) * 100}
      y={((hi - pitch) / span) * 22 + 0.5}
      width={Math.max(0.6, ((stop - start) / end) * 100)}
      height={Math.max(0.8, 22 / span)}
      rx="0.4"
    />
  {/each}
</svg>

<style>
  .mini {
    width: 100%;
    height: 28px;
    display: block;
  }
  rect {
    fill: var(--note);
    opacity: 0.75;
  }
</style>
