<script lang="ts">
  /** Minimal stroke icon set (inline SVG, no icon font, works offline). */
  type Name =
    | 'back' | 'more' | 'play' | 'pause' | 'settings' | 'share' | 'trash' | 'undo' | 'redo'
    | 'plus' | 'edit' | 'zoom-in' | 'zoom-out' | 'refresh' | 'close' | 'up' | 'down'
    | 'left' | 'right' | 'check' | 'mic' | 'camera' | 'shorter' | 'longer' | 'import' | 'loop';

  let { name, size = 20, label }: { name: Name; size?: number; label?: string } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>
  {#if name === 'back'}<path d="M15 5l-7 7 7 7" />
  {:else if name === 'more'}<circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" />
  {:else if name === 'play'}<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  {:else if name === 'pause'}<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />
  {:else if name === 'settings'}<path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" />
  {:else if name === 'share'}<path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
  {:else if name === 'trash'}<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  {:else if name === 'undo'}<path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  {:else if name === 'redo'}<path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'edit'}<path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" />
  {:else if name === 'zoom-in'}<circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5" />
  {:else if name === 'zoom-out'}<circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5M8.5 11h5" />
  {:else if name === 'refresh'}<path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  {:else if name === 'close'}<path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'up'}<path d="M6 15l6-6 6 6" />
  {:else if name === 'down'}<path d="M6 9l6 6 6-6" />
  {:else if name === 'left'}<path d="M15 6l-6 6 6 6" />
  {:else if name === 'right'}<path d="M9 6l6 6-6 6" />
  {:else if name === 'check'}<path d="M5 12.5l4.5 4.5L19 7.5" />
  {:else if name === 'mic'}<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  {:else if name === 'camera'}<path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
  {:else if name === 'shorter'}<path d="M4 12h9M10 8l-4 4 4 4M20 5v14" />
  {:else if name === 'longer'}<path d="M4 12h13M14 8l4 4-4 4M20 5v14" />
  {:else if name === 'loop'}<path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 0 1 4-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 0 1-4 4H4" />
  {:else if name === 'import'}<path d="M12 15V3M7 10l5 5 5-5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  {/if}
</svg>
