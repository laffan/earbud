<script lang="ts">
  /**
   * A text note on the canvas: markdown, in a box that sits at a point of
   * the timeline (its size is in pixels, so zooming moves it but does not
   * stretch it). A note that is nothing but emoji is shown large (50 px)
   * and without a box. Editing happens in place; the canvas handles moving
   * (by `data-tile`) and resizing (the corner, by `data-resize`).
   */
  import { NOTE_W, RULER_H } from './canvasGeometry';
  import { isEmojiOnly, renderMarkdown } from './markdown';

  interface Props {
    /** The note's id; null for a note being written that is not saved yet. */
    id: string | null;
    text: string;
    /** Box size (px); null = fit the text. */
    width: number | null;
    height: number | null;
    /** Where it is drawn (world px). */
    left: number;
    top: number;
    editing: boolean;
    lifted?: boolean;
    /** Editing finished (blur, Escape, ⌘/Ctrl+Enter) with this text. */
    onsubmit?: (text: string) => void;
  }

  let { id, text, width, height, left, top, editing, lifted = false, onsubmit }: Props = $props();

  // svelte-ignore state_referenced_locally
  let value = $state(text);
  let area = $state<HTMLTextAreaElement | null>(null);
  let submitted = false;

  const emoji = $derived(isEmojiOnly(editing ? value : text));
  const html = $derived(renderMarkdown(text));

  $effect(() => {
    if (editing) {
      submitted = false;
      value = text;
    }
  });

  $effect(() => {
    const el = area;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    fit(el);
  });

  function fit(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function finish() {
    if (submitted) return;
    submitted = true;
    onsubmit?.(value);
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      area?.blur();
    }
  }

  // Editing: the box fits what is typed (an emoji-only note is shown as it will look).
  const boxWidth = $derived(width ?? (emoji ? null : NOTE_W));
</script>

<div
  class="note"
  class:emoji
  class:editing
  class:lifted
  data-tile={id ?? undefined}
  style:transform="translate({left}px, {top + RULER_H}px)"
  style:width={boxWidth !== null ? `${boxWidth}px` : undefined}
  style:min-height={height !== null ? `${height}px` : undefined}
  role="note"
  aria-label={text ? `Note: ${text.slice(0, 60)}` : 'New note'}
>
  {#if editing}
    <textarea
      bind:this={area}
      bind:value
      rows="1"
      placeholder="Write a note (markdown)"
      aria-label="Note text"
      maxlength="20000"
      oninput={(e) => fit(e.currentTarget)}
      onblur={finish}
      onkeydown={onKey}
      onpointerdown={(e) => e.stopPropagation()}
    ></textarea>
  {:else}
    <!-- Escaped and limited to a fixed set of tags by renderMarkdown. -->
    <div class="md">{@html html}</div>
    {#if id}<div class="corner" data-resize={id} aria-hidden="true"></div>{/if}
  {/if}
</div>

<style>
  .note {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 2;
    padding: 7px 10px 8px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--paper-raised) 90%, var(--chord));
    border: 1px solid var(--rule);
    box-shadow: 0 1px 2px rgb(40 30 10 / 8%);
    color: var(--ink);
    font-size: 0.88rem;
    line-height: 1.35;
    overflow-wrap: anywhere;
    will-change: transform;
  }
  .note.emoji {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    padding: 0 4px;
    font-size: 50px;
    line-height: 1.15;
    width: max-content;
  }
  .note.editing {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
    background: var(--paper-raised);
  }
  .note.lifted {
    scale: 1.03;
    box-shadow: 0 10px 28px rgb(40 30 10 / 22%);
  }
  textarea {
    display: block;
    width: 100%;
    min-width: 160px;
    resize: none;
    border: none;
    outline: none;
    background: transparent;
    padding: 0;
    font: inherit;
    line-height: inherit;
    color: inherit;
    overflow: hidden;
  }
  .emoji textarea {
    min-width: 1.4em;
    width: 3em;
  }
  .md :global(:first-child) {
    margin-top: 0;
  }
  .md :global(:last-child) {
    margin-bottom: 0;
  }
  .md :global(p),
  .md :global(ul),
  .md :global(ol),
  .md :global(blockquote),
  .md :global(pre) {
    margin: 0 0 6px;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3) {
    margin: 0 0 4px;
    font-family: var(--font-serif);
    line-height: 1.2;
  }
  .md :global(h1) {
    font-size: 1.35rem;
  }
  .md :global(h2) {
    font-size: 1.15rem;
  }
  .md :global(h3) {
    font-size: 1rem;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.2em;
  }
  .md :global(blockquote) {
    padding-left: 8px;
    border-left: 3px solid var(--rule-strong);
    color: var(--ink-2);
  }
  .md :global(code) {
    font-family: var(--font-mono);
    font-size: 0.85em;
    padding: 0 3px;
    border-radius: 4px;
    background: var(--paper-sunk);
  }
  .md :global(pre) {
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--paper-sunk);
    overflow-x: auto;
  }
  .md :global(pre code) {
    padding: 0;
    background: none;
  }
  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--rule-strong);
    margin: 6px 0;
  }
  .md :global(a) {
    color: var(--note);
  }
  .md :global(.task) {
    color: var(--ink-3);
  }
  .corner {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--rule-strong) 50%, var(--rule-strong) 58%, transparent 58%, transparent 70%, var(--rule-strong) 70%, var(--rule-strong) 78%, transparent 78%);
    border-bottom-right-radius: 8px;
  }
</style>
