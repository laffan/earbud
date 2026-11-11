<script lang="ts">
  import { app } from '../state/app.svelte';
  import Icon from './Icon.svelte';
  import RecordButton from './RecordButton.svelte';
  import SettingsSheet from './SettingsSheet.svelte';
  import Sheet from './Sheet.svelte';
  import SketchCard from './SketchCard.svelte';
  import SwipeRow from './SwipeRow.svelte';
  import { displayTitle, groupByDay } from './format';

  let showSettings = $state(false);
  /** Row whose swipe actions are revealed (only one at a time). */
  let openRow = $state<string | null>(null);
  let selecting = $state(false);
  let selectedIds = $state<string[]>([]);
  let pendingDelete = $state<string[] | null>(null);

  function startSelecting(id: string) {
    openRow = null;
    selecting = true;
    selectedIds = [id];
  }

  function toggle(id: string) {
    selectedIds = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
  }

  function stopSelecting() {
    selecting = false;
    selectedIds = [];
  }

  function share(ids: string[]) {
    openRow = null;
    app.shareSketches(ids);
  }

  async function confirmDelete() {
    const ids = pendingDelete ?? [];
    pendingDelete = null;
    openRow = null;
    await app.deleteSketches(ids);
    stopSelecting();
  }

  /** A tap anywhere outside the open row closes it. */
  function closeOpenRow(e: PointerEvent) {
    if (!openRow) return;
    const row = (e.target as HTMLElement).closest('[data-sketch-id]');
    if (row?.getAttribute('data-sketch-id') !== openRow) openRow = null;
  }
  const groups = $derived(groupByDay(app.sketches));
  const captureHint = $derived(
    app.settings.camera === 'none'
      ? 'Audio only'
      : `${app.settings.camera === 'front' ? 'Front' : 'Back'} camera${
          app.capabilities?.nativeCapture && app.settings.camera === 'back' && app.settings.lens === 'ultraWide'
            ? ', ultra wide'
            : ''
        }`,
  );
</script>

<div class="home">
  <header>
    {#if selecting}
      <button class="pill-button" onclick={stopSelecting}>Cancel</button>
      <span class="count">{selectedIds.length} selected</span>
      <div class="select-actions">
        <button
          class="pill-button"
          onclick={() => (selectedIds = selectedIds.length === app.sketches.length ? [] : app.sketches.map((s) => s.id))}
          >{selectedIds.length === app.sketches.length ? 'None' : 'All'}</button
        >
        <button class="icon-button" onclick={() => share(selectedIds)} disabled={selectedIds.length === 0} aria-label="Share selected">
          <Icon name="share" />
        </button>
        <button
          class="icon-button danger"
          onclick={() => (pendingDelete = [...selectedIds])}
          disabled={selectedIds.length === 0}
          aria-label="Delete selected"
        >
          <Icon name="trash" />
        </button>
      </div>
    {:else}
      <div class="brand">
        <h1 class="serif">Earbud</h1>
        <span class="tagline">musical sketchbook</span>
      </div>
      <button class="icon-button" onclick={() => (showSettings = true)} aria-label="Settings">
        <Icon name="settings" />
      </button>
    {/if}
  </header>

  <main onpointerdowncapture={closeOpenRow}>
    {#if app.ready && app.sketches.length === 0}
      <div class="empty">
        <p class="serif lead">An empty page.</p>
        <p>
          Prop your phone above the keys and tap record. Earbud keeps the take, writes down the notes and chords,
          and files it here — no connection needed.
        </p>
      </div>
    {/if}

    {#each groups as group (group.label)}
      <section>
        <h2>{group.label}</h2>
        <div class="list">
          {#each group.items as sketch (sketch.id)}
            <div data-sketch-id={sketch.id}>
              <SwipeRow
                label={displayTitle(sketch)}
                {selecting}
                selected={selectedIds.includes(sketch.id)}
                open={openRow === sketch.id}
                onopenchange={(open) => (openRow = open ? sketch.id : null)}
                onactivate={() => (selecting ? toggle(sketch.id) : app.openSketch(sketch.id))}
                onlongpress={() => startSelecting(sketch.id)}
                onshare={() => share([sketch.id])}
                ondelete={() => (pendingDelete = [sketch.id])}
              >
                <SketchCard {sketch} job={app.jobs[sketch.id]} selected={selecting && selectedIds.includes(sketch.id)} />
              </SwipeRow>
            </div>
          {/each}
        </div>
      </section>
    {/each}

    {#if app.sketches.length > 0 && !selecting}
      <p class="gesture-hint">Swipe a sketch left to share or delete it. Press and hold to select several.</p>
    {/if}
  </main>

  <footer class="dock" class:hidden={selecting}>
    <RecordButton
      onclick={() => app.startRecording()}
      disabled={!app.ready || !app.canRecord || app.recording !== null}
      busy={app.recording !== null}
    />
    <button class="hint" onclick={() => (showSettings = true)}>
      {#if app.ready && !app.canRecord}
        Recording is not available here
      {:else}
        <Icon name={app.settings.camera === 'none' ? 'mic' : 'camera'} size={14} />
        {captureHint}
      {/if}
    </button>
  </footer>
</div>

{#if showSettings}
  <SettingsSheet onclose={() => (showSettings = false)} />
{/if}

{#if pendingDelete}
  {@const n = pendingDelete.length}
  <Sheet title={n === 1 ? 'Delete this sketch?' : `Delete ${n} sketches?`} onclose={() => (pendingDelete = null)}>
    <p class="confirm">
      {n === 1 ? 'The recording, its transcription and your notes' : 'The recordings, their transcriptions and your notes'}
      will be permanently removed from this device.
    </p>
    <div class="confirm-actions">
      <button class="pill-button danger" onclick={confirmDelete}>Delete</button>
      <button class="pill-button" onclick={() => (pendingDelete = null)}>Cancel</button>
    </div>
  </Sheet>
{/if}

<style>
  .home {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(var(--safe-top) + 10px) calc(var(--safe-right) + 14px) 10px calc(var(--safe-left) + 20px);
    background: color-mix(in srgb, var(--paper) 92%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .brand {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .tagline {
    color: var(--ink-3);
    font-size: 0.9rem;
    font-style: italic;
    font-family: var(--font-serif);
  }
  main {
    flex: 1;
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: 4px calc(var(--safe-right) + 16px) 170px calc(var(--safe-left) + 16px);
  }
  section {
    margin-top: 14px;
  }
  h2 {
    margin: 0 4px 8px;
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .list {
    display: grid;
    gap: 10px;
  }
  .empty {
    margin: 12vh auto 0;
    max-width: 420px;
    text-align: center;
    color: var(--ink-2);
  }
  .lead {
    font-size: 1.5rem;
    color: var(--ink);
    margin-bottom: 6px;
  }
  .dock {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 18px 16px calc(var(--safe-bottom) + 14px);
    background: linear-gradient(to top, var(--paper) 62%, transparent);
    pointer-events: none;
  }
  .dock > :global(*) {
    pointer-events: auto;
  }
  .count {
    font-weight: 600;
  }
  .select-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .icon-button.danger {
    color: var(--accent);
  }
  .gesture-hint {
    margin: 18px 4px 0;
    text-align: center;
    font-size: 0.78rem;
    color: var(--ink-3);
  }
  .dock.hidden {
    display: none;
  }
  .confirm {
    margin: 0 0 16px;
    color: var(--ink-2);
  }
  .confirm-actions {
    display: flex;
    gap: 8px;
  }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.8rem;
    color: var(--ink-3);
    padding: 2px 8px;
  }
</style>
