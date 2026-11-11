<script lang="ts">
  /**
   * List row with iOS-style gestures:
   *  - swipe left to reveal Share / Delete underneath,
   *  - long press (or right-click) to start multi-selection,
   *  - tap to open, or to toggle selection while selecting.
   * Vertical drags are left to the browser so the list scrolls natively.
   */
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    label: string;
    selecting?: boolean;
    selected?: boolean;
    open?: boolean;
    onopenchange?: (open: boolean) => void;
    onactivate?: () => void;
    onlongpress?: () => void;
    onshare?: () => void;
    ondelete?: () => void;
    children: Snippet;
  }

  let {
    label,
    selecting = false,
    selected = false,
    open = false,
    onopenchange,
    onactivate,
    onlongpress,
    onshare,
    ondelete,
    children,
  }: Props = $props();

  const ACTIONS_WIDTH = 152;
  const LONG_PRESS_MS = 500;

  let dragOffset = $state<number | null>(null);
  const offset = $derived(dragOffset ?? (open && !selecting ? -ACTIONS_WIDTH : 0));

  let start: { x: number; y: number; offset: number; time: number } | null = null;
  let mode: 'pending' | 'swipe' | 'scroll' | null = null;
  let pressTimer: number | undefined;
  let suppressClick = false;

  function clearPress() {
    window.clearTimeout(pressTimer);
    pressTimer = undefined;
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, offset, time: performance.now() };
    mode = 'pending';
    suppressClick = false;
    clearPress();
    if (!selecting && onlongpress) {
      pressTimer = window.setTimeout(() => {
        pressTimer = undefined;
        if (mode !== 'pending') return;
        suppressClick = true;
        mode = null;
        dragOffset = null;
        onopenchange?.(false);
        (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(10);
        onlongpress();
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!start || !mode || mode === 'scroll') return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (mode === 'pending') {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2 && !selecting) {
        mode = 'swipe';
        clearPress();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } else if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        mode = 'scroll';
        clearPress();
        return;
      } else {
        return;
      }
    }
    let next = start.offset + dx;
    // Rubber band past either end.
    if (next > 0) next = next / 4;
    if (next < -ACTIONS_WIDTH) next = -ACTIONS_WIDTH + (next + ACTIONS_WIDTH) / 4;
    dragOffset = next;
  }

  function onPointerUp() {
    clearPress();
    if (mode === 'swipe' && start && dragOffset !== null) {
      suppressClick = true;
      const travelled = dragOffset - start.offset;
      const fast = Math.abs(travelled) > 30 && performance.now() - start.time < 250;
      const shouldOpen = fast ? travelled < 0 : dragOffset < -ACTIONS_WIDTH / 2;
      onopenchange?.(shouldOpen);
    }
    dragOffset = null;
    start = null;
    mode = null;
  }

  function onPointerCancel() {
    clearPress();
    dragOffset = null;
    start = null;
    mode = null;
  }

  function onClick(e: MouseEvent) {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    if (open && !selecting) {
      onopenchange?.(false);
      return;
    }
    onactivate?.();
  }

  function onContextMenu(e: MouseEvent) {
    // Right-click on desktop behaves like a long press.
    e.preventDefault();
    if (!selecting) onlongpress?.();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onactivate?.();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      ondelete?.();
    }
  }
</script>

<div class="row" class:selecting data-open={open}>
  <div class="actions" aria-hidden={!open || selecting}>
    <button class="action share" tabindex={open ? 0 : -1} onclick={() => onshare?.()}>
      <Icon name="share" size={20} /><span>Share</span>
    </button>
    <button class="action delete" tabindex={open ? 0 : -1} onclick={() => ondelete?.()}>
      <Icon name="trash" size={20} /><span>Delete</span>
    </button>
  </div>
  <div
    class="front"
    class:dragging={dragOffset !== null}
    style:transform="translateX({offset}px)"
    role="button"
    tabindex="0"
    aria-label={label}
    aria-pressed={selecting ? selected : undefined}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onclick={onClick}
    oncontextmenu={onContextMenu}
    onkeydown={onKeyDown}
  >
    {#if selecting}
      <span class="check" class:on={selected} aria-hidden="true">
        {#if selected}<Icon name="check" size={14} />{/if}
      </span>
    {/if}
    <div class="content">{@render children()}</div>
  </div>
</div>

<style>
  .row {
    position: relative;
    border-radius: var(--radius);
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .actions {
    position: absolute;
    inset: 0 0 0 auto;
    width: 152px;
    display: flex;
  }
  .action {
    flex: 1;
    display: grid;
    place-items: center;
    align-content: center;
    gap: 4px;
    font-size: 0.78rem;
    font-weight: 600;
    color: #fff;
  }
  .share {
    background: #5a6f86;
  }
  .delete {
    background: var(--accent);
  }
  .front {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--paper);
    touch-action: pan-y;
    transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    cursor: pointer;
    outline: none;
  }
  .front.dragging {
    transition: none;
  }
  .front:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent);
    border-radius: var(--radius);
  }
  .content {
    flex: 1;
    min-width: 0;
  }
  .check {
    flex: none;
    width: 24px;
    height: 24px;
    margin-left: 4px;
    border-radius: 50%;
    border: 2px solid var(--rule-strong);
    display: grid;
    place-items: center;
    color: var(--accent-ink);
  }
  .check.on {
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
