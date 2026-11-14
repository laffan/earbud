<script lang="ts">
  /**
   * One track of a sketch: a title bar (collapse, name, current chord,
   * mute / solo / record-a-new-take toggles, menu), then the piano roll
   * with the waveform attached underneath, or, collapsed, a short strip of
   * the notes. Editing the notes of the take that plays happens here.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { Sketch, SketchDetail, Track, UpdateTrackArgs } from '../library/types';
  import { chordVoicing, detectChords, type ChordSegment } from '../music/chords';
  import { notesToMidi } from '../music/midi';
  import { normalizeNote, sortNotes } from '../music/notes';
  import { canJoin, joinNotes, shiftNotes, type NoteShift } from '../music/selection';
  import { summarize } from '../music/summary';
  import type { NoteSynth } from '../music/synth';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import { environmentName, type Environment, type HeldNotes } from '../transcription/settings';
  import type { PianoNote } from '../transcription/types';
  import Icon from './Icon.svelte';
  import PianoRoll from './PianoRoll.svelte';
  import type { RollViewport } from './rollViewport.svelte';
  import Sheet from './Sheet.svelte';
  import TranscriptionSettings from './TranscriptionSettings.svelte';
  import Waveform from './Waveform.svelte';
  import { formatDate, formatTimeOfDay } from './format';

  interface Props {
    track: Track;
    /** The take that plays (its row in the library). */
    take: Sketch;
    sketchTitle: string;
    /** Length of the sketch's timeline (seconds). */
    duration: number;
    currentTime: number;
    playing: boolean;
    cropStart: number | null;
    cropEnd: number | null;
    view: RollViewport;
    /** The sketch has several tracks (smaller rolls). */
    multi: boolean;
    audible: boolean;
    armed: boolean;
    /** A take can be recorded right now. */
    canRecord: boolean;
    /** Not the track that holds the sketch's own recording. */
    deletable: boolean;
    synth: NoteSynth;
    onseek: (time: number) => void;
    oncropchange: (start: number, end: number, done: boolean) => void;
    onupdate: (patch: Omit<UpdateTrackArgs, 'id'>) => void;
    onarm: () => void;
    ondelete: () => void;
    ondeletetake: (takeId: string) => void;
    /** The notes changed (loaded, transcribed or edited), in the take's own time. */
    onnotes: (notes: PianoNote[]) => void;
  }

  let {
    track,
    take,
    sketchTitle,
    duration,
    currentTime,
    playing,
    cropStart,
    cropEnd,
    view,
    multi,
    audible,
    armed,
    canRecord,
    deletable,
    synth,
    onseek,
    oncropchange,
    onupdate,
    onarm,
    ondelete,
    ondeletetake,
    onnotes,
  }: Props = $props();

  // ------------------------------------------------------------ data
  let detail = $state<SketchDetail | null>(null);
  // Replaced wholesale on every edit; raw keeps object identity (selection, undo).
  let notes = $state.raw<PianoNote[]>([]);
  let name = $state(untrack(() => track.name));

  // ---------------------------------------------------------- editing
  let editing = $state(false);
  let selection = $state<number[]>([]);
  let undoStack: PianoNote[][] = [];
  let redoStack: PianoNote[][] = [];
  let canUndo = $state(false);
  let canRedo = $state(false);
  let dirty = false;
  let saveTimer: number | undefined;
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // --------------------------------------------------------------- ui
  let showMenu = $state(false);
  let showRetranscribe = $state(false);
  let retranscribeDiscards = $state(false);
  let confirmation = $state<{
    title: string;
    message: string;
    action: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);

  const offset = $derived(take.offsetMs / 1000);
  const live = $derived(app.sketches.find((s) => s.id === take.id) ?? detail ?? take);
  const job = $derived(app.jobs[take.id]);
  const transcribing = $derived(!!job || live.transcriptionStatus === 'running');
  const hasTranscription = $derived(!!detail?.transcription);
  const chords = $derived(detectChords(notes));
  const takeTime = $derived(currentTime - offset);
  const currentChord = $derived(chords.find((c) => takeTime >= c.startTime && takeTime < c.endTime));
  const collapsed = $derived(track.collapsed);
  const takeNumber = $derived(track.takes.findIndex((t) => t.id === take.id) + 1);
  const label = $derived(track.name || `Track ${track.position + 1}`);

  function workingNotes(d: SketchDetail): PianoNote[] {
    const t = d.transcription;
    return sortNotes(t ? (t.editedNotes ?? t.originalNotes) : []);
  }

  function setNotes(next: PianoNote[]) {
    notes = next;
    onnotes(next);
  }

  async function load() {
    try {
      const d = await app.library.get(take.id);
      detail = d;
      if (!dirty) {
        setNotes(workingNotes(d));
        selection = selection.filter((i) => i < notes.length);
      }
    } catch {
      // deleted
    }
  }

  let seenRevision = untrack(() => app.revision[take.id] ?? 0);
  $effect(() => {
    const revision = app.revision[take.id] ?? 0;
    if (revision !== seenRevision) {
      seenRevision = revision;
      untrack(() => void load());
    }
  });

  $effect(() => {
    // Keep the name field in step when the track is renamed elsewhere.
    const n = track.name;
    untrack(() => {
      if (document.activeElement?.getAttribute('data-track') !== track.id) name = n;
    });
  });

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    void saveNow();
  });

  // ---------------------------------------------------------- editing

  function updateHistory() {
    canUndo = undoStack.length > 0;
    canRedo = redoStack.length > 0;
  }

  function afterChange() {
    updateHistory();
    onnotes(notes);
    dirty = true;
    saveState = 'saving';
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveNow(), 700);
  }

  /** Apply an edit; `focus` are the notes that stay selected afterwards. */
  function commit(next: PianoNote[], focus: PianoNote[]) {
    undoStack.push(notes);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    const sorted = sortNotes(next);
    const wanted = new Set(focus);
    const indices: number[] = [];
    if (wanted.size > 0) sorted.forEach((n, i) => wanted.has(n) && indices.push(i));
    notes = sorted;
    selection = indices;
    afterChange();
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(notes);
    notes = previous;
    selection = [];
    afterChange();
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(notes);
    notes = next;
    selection = [];
    afterChange();
  }

  const selectedIndices = $derived(selection.filter((i) => i < notes.length));
  const hasSelection = $derived(selectedIndices.length > 0);
  const joinable = $derived(canJoin(notes, selectedIndices));

  function modifySelected(shift: NoteShift) {
    const indices = selectedIndices;
    if (indices.length === 0) return;
    const originals = indices.map((i) => notes[i]);
    const changed = shiftNotes(originals, shift, duration + 30);
    const next = notes.slice();
    indices.forEach((index, k) => (next[index] = changed[k]));
    commit(next, changed);
    if (changed.length === 1 && changed[0].pitch !== originals[0].pitch) synth.preview(changed[0].pitch);
  }

  function deleteSelected() {
    const gone = new Set(selectedIndices);
    if (gone.size === 0) return;
    commit(
      notes.filter((_, i) => !gone.has(i)),
      [],
    );
  }

  function joinSelected() {
    const result = joinNotes(notes, selectedIndices);
    if (result) commit(result.notes, result.selected);
  }

  function selectAll() {
    selection = notes.map((_, i) => i);
  }

  function addNote() {
    const at = Math.max(0, takeTime);
    const sounding = notes.filter((n) => n.startTime <= at && n.endTime > at);
    const pitch = sounding.length ? Math.max(...sounding.map((n) => n.pitch)) + 2 : 60;
    const n = normalizeNote({ pitch, startTime: at, endTime: at + 0.5, velocity: 80, confidence: 1 });
    commit([...notes, n], [n]);
    synth.preview(n.pitch);
  }

  /** Write pending edits now (also used before sharing). */
  export async function saveNow() {
    window.clearTimeout(saveTimer);
    if (!dirty || !detail?.transcription) return;
    const snapshot = notes;
    dirty = false;
    try {
      const d = await app.library.saveEdits({ id: take.id, notes: snapshot, summary: summarize(snapshot) });
      detail = d;
      app.upsert(d);
      await app.library.writeFile(take.id, 'midi', notesToMidi(snapshot, { title: sketchTitle || undefined }));
      saveState = dirty ? 'saving' : 'saved';
    } catch (error) {
      dirty = true;
      saveState = 'error';
      app.toast(`Could not save your edits: ${errorMessage(error)}`, 'error');
    }
  }

  function toggleEditing() {
    editing = !editing;
    if (!editing) {
      selection = [];
      void saveNow();
    }
  }

  function playChord(chord: ChordSegment) {
    synth.playChord(chordVoicing(chord, notes));
    if (!playing) onseek(chord.startTime + offset);
  }

  function onKey(e: KeyboardEvent) {
    if (!editing) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  }

  // ------------------------------------------------------------ track

  function toggleCollapsed() {
    if (!collapsed && editing) toggleEditing();
    onupdate({ collapsed: !collapsed });
  }

  function saveName() {
    const next = name.trim();
    if (next && next !== track.name) onupdate({ name: next });
    else name = track.name;
  }

  /** Nudge the take on the timeline (to line it up by ear). */
  function nudge(ms: number) {
    onupdate({ offsetMs: take.offsetMs + ms });
  }

  // ------------------------------------------------------------ actions

  function retranscribe() {
    showMenu = false;
    showRetranscribe = false;
    editing = false;
    selection = [];
    dirty = false;
    window.clearTimeout(saveTimer);
    undoStack = [];
    redoStack = [];
    updateHistory();
    app.transcribe(take.id);
  }

  function askRetranscribe() {
    showMenu = false;
    if (hasTranscription) {
      retranscribeDiscards = !!detail?.hasEdits || dirty;
      showRetranscribe = true;
    } else retranscribe();
  }

  const transcribedWith = $derived.by(() => {
    const params = detail?.transcription?.params;
    if (!params) return '';
    const parts: string[] = [];
    const environment = params.environment as Environment | undefined;
    if (environment) parts.push(environmentName(environment));
    const heldNotes = params.heldNotes as HeldNotes | undefined;
    if (heldNotes === 'join') parts.push('held notes joined');
    else if (heldNotes === 'strong') parts.push('held notes joined (more)');
    return parts.join(', ');
  });

  function revertEdits() {
    showMenu = false;
    confirmation = {
      title: 'Revert to the original transcription?',
      message: 'Your note corrections on this take will be discarded. The recording is not affected.',
      action: 'Revert',
      danger: true,
      run: async () => {
        const original = detail?.transcription?.originalNotes;
        if (!original) return;
        window.clearTimeout(saveTimer);
        dirty = false;
        const d = await app.library.resetEdits(take.id, summarize(original));
        detail = d;
        app.upsert(d);
        undoStack = [];
        redoStack = [];
        selection = [];
        updateHistory();
        setNotes(sortNotes(original));
        await app.library.writeFile(take.id, 'midi', notesToMidi(notes, { title: sketchTitle || undefined }));
      },
    };
  }

  function confirmDeleteTake() {
    showMenu = false;
    confirmation = {
      title: `Delete take ${takeNumber}?`,
      message:
        track.takes.length > 1
          ? 'This recording and its notes will be removed. The track plays its latest other take.'
          : 'This is the only take, so the track is removed with it.',
      action: 'Delete take',
      danger: true,
      run: () => ondeletetake(take.id),
    };
  }

  function confirmDeleteTrack() {
    showMenu = false;
    confirmation = {
      title: `Delete ${label}?`,
      message: `${track.takes.length === 1 ? 'Its recording' : `All ${track.takes.length} takes`} and their notes will be removed from this device.`,
      action: 'Delete track',
      danger: true,
      run: ondelete,
    };
  }

  function chooseTake(id: string) {
    showMenu = false;
    if (id !== take.id) onupdate({ takeId: id });
  }
</script>

<svelte:window onkeydown={onKey} />

<section class="track" class:collapsed class:muted={!audible} class:armed aria-label={label}>
  <header class="track-bar">
    <button
      class="icon-button collapse"
      onclick={toggleCollapsed}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
    >
      <Icon name="down" size={18} />
    </button>
    <input
      class="track-name"
      data-track={track.id}
      bind:value={name}
      maxlength="60"
      aria-label="Track name"
      onblur={saveName}
      onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
    {#if track.takes.length > 1}<span class="take-chip tabular" title="Take {takeNumber} of {track.takes.length}">take {takeNumber}</span>{/if}
    <span class="chord-now serif" aria-live="polite">{currentChord?.symbol ?? ''}</span>
    {#if collapsed && transcribing}<span class="mini-status">{Math.round((job?.fraction ?? 0) * 100)}%</span>{/if}
    <span class="spacer"></span>
    <div class="toggles" role="group" aria-label="{label} controls">
      <button
        class="toggle mute"
        aria-pressed={track.muted}
        aria-label="Mute"
        title="Mute"
        onclick={() => onupdate({ muted: !track.muted })}>M</button
      >
      <button
        class="toggle solo"
        aria-pressed={track.solo}
        aria-label="Solo"
        title="Solo"
        onclick={() => onupdate({ solo: !track.solo })}>S</button
      >
      <button
        class="toggle arm"
        aria-pressed={armed}
        aria-label="Record a new take"
        title="Record a new take"
        disabled={!canRecord && !armed}
        onclick={onarm}><span class="rec-dot"></span></button
      >
    </div>
    <div class="menu-anchor">
      <button class="icon-button" onclick={() => (showMenu = !showMenu)} aria-label="{label} actions" aria-expanded={showMenu}>
        <Icon name="more" />
      </button>
      {#if showMenu}
        <div class="menu" role="menu">
          {#if track.takes.length > 1}
            <div class="menu-label">Takes</div>
            {#each track.takes as t, i (t.id)}
              <button
                role="menuitemradio"
                aria-checked={t.id === take.id}
                onclick={() => chooseTake(t.id)}
                disabled={t.status !== 'saved'}
              >
                <span class="check">{#if t.id === take.id}<Icon name="check" size={16} />{/if}</span>
                Take {i + 1}
                <span class="dim">{formatDate(t.createdAt)}, {formatTimeOfDay(t.createdAt)}</span>
              </button>
            {/each}
            <div class="menu-sep"></div>
          {/if}
          <button role="menuitem" onclick={askRetranscribe} disabled={transcribing}>
            <Icon name="refresh" size={18} /> {hasTranscription ? 'Transcribe again' : 'Transcribe'}
          </button>
          {#if detail?.hasEdits}
            <button role="menuitem" onclick={revertEdits}><Icon name="undo" size={18} /> Revert note edits</button>
          {/if}
          <div class="nudge" role="group" aria-label="Line up this take">
            <span>Line up</span>
            <button onclick={() => nudge(-20)} aria-label="Move this take 20 ms earlier"><Icon name="left" size={16} /></button>
            <span class="tabular dim">{take.offsetMs >= 0 ? '+' : ''}{(take.offsetMs / 1000).toFixed(2)} s</span>
            <button onclick={() => nudge(20)} aria-label="Move this take 20 ms later"><Icon name="right" size={16} /></button>
          </div>
          {#if transcribedWith || detail?.transcription}
            <p class="menu-info">
              {#if detail?.transcription}Transcribed by {detail.transcription.engine} {detail.transcription.engineVersion}{/if}{#if transcribedWith}, for {transcribedWith}{/if}
            </p>
          {/if}
          {#if take.parentId !== null}
            <button role="menuitem" class="danger" onclick={confirmDeleteTake}><Icon name="trash" size={18} /> Delete this take</button>
          {/if}
          {#if deletable}
            <button role="menuitem" class="danger" onclick={confirmDeleteTrack}><Icon name="trash" size={18} /> Delete track</button>
          {/if}
        </div>
      {/if}
    </div>
  </header>

  {#if collapsed}
    <div class="stack compact">
      <div class="roll-wrap compact">
        <PianoRoll {notes} {duration} {currentTime} {playing} {cropStart} {cropEnd} {offset} {view} compact {onseek} />
      </div>
    </div>
  {:else}
    {#if transcribing}
      <div class="banner">
        <span>
          {#if job?.stage === 'queued'}Waiting to transcribe…
          {:else if job?.stage === 'audio'}Preparing audio…
          {:else if job?.stage === 'saving'}Saving notes…
          {:else}Transcribing {Math.round((job?.fraction ?? 0) * 100)}%{/if}
        </span>
        <div class="progress"><div style:width="{Math.round((job?.fraction ?? 0) * 100)}%"></div></div>
      </div>
    {:else if live.transcriptionStatus === 'failed'}
      <div class="banner warn">
        <span>Transcription failed: {live.transcriptionError ?? 'unknown error'}. The recording is safe.</span>
        <button class="pill-button" onclick={retranscribe}>Try again</button>
      </div>
    {:else if detail && !hasTranscription && live.status === 'saved'}
      <div class="banner">
        <span>Not transcribed yet.</span>
        <button class="pill-button" onclick={retranscribe}>Transcribe</button>
      </div>
    {:else if live.status === 'recording'}
      <div class="banner"><span>Recording…</span></div>
    {/if}

    {#if editing}
      <div class="edit-toolbar" role="toolbar" aria-label="Note editing">
        <button class="icon-button" onclick={undo} disabled={!canUndo} aria-label="Undo"><Icon name="undo" /></button>
        <button class="icon-button" onclick={redo} disabled={!canRedo} aria-label="Redo"><Icon name="redo" /></button>
        <span class="sep"></span>
        <button class="icon-button" onclick={addNote} aria-label="Add note at playhead"><Icon name="plus" /></button>
        <button class="icon-button" onclick={deleteSelected} disabled={!hasSelection} aria-label="Delete selected notes"
          ><Icon name="trash" /></button
        >
        <button
          class="pill-button join"
          onclick={joinSelected}
          disabled={!joinable}
          title="Join selected notes of the same pitch into one"
          aria-label="Join selected notes of the same pitch">Join</button
        >
        <span class="sep"></span>
        <button class="icon-button" onclick={() => modifySelected({ pitch: 1 })} disabled={!hasSelection} aria-label="Semitone up"><Icon name="up" /></button>
        <button class="icon-button" onclick={() => modifySelected({ pitch: -1 })} disabled={!hasSelection} aria-label="Semitone down"><Icon name="down" /></button>
        <button class="icon-button" onclick={() => modifySelected({ time: -0.05 })} disabled={!hasSelection} aria-label="Earlier"><Icon name="left" /></button>
        <button class="icon-button" onclick={() => modifySelected({ time: 0.05 })} disabled={!hasSelection} aria-label="Later"><Icon name="right" /></button>
        <button class="icon-button" onclick={() => modifySelected({ end: -0.1 })} disabled={!hasSelection} aria-label="Shorter"><Icon name="shorter" /></button>
        <button class="icon-button" onclick={() => modifySelected({ end: 0.1 })} disabled={!hasSelection} aria-label="Longer"><Icon name="longer" /></button>
        <span class="spacer"></span>
        <span class="save-state">
          {#if saveState === 'saving'}Saving…{:else if saveState === 'saved'}Saved{:else if saveState === 'error'}Not saved{/if}
        </span>
      </div>
      <p class="edit-help">
        {#if hasSelection}
          <span class="selection-count" aria-live="polite"
            >{selectedIndices.length} {selectedIndices.length === 1 ? 'note' : 'notes'} selected</span
          >
          <button class="link" onclick={() => (selection = [])}>Deselect</button>
          {#if selectedIndices.length < notes.length}<button class="link" onclick={selectAll}>Select all</button>{/if}
        {:else}
          Tap a note to select it. Drag to scroll; press and hold, then drag, to select several (or to pick up a
          note). Drag a selected note to move the selection, drag an end to resize, double-tap to add.
        {/if}
      </p>
    {/if}

    <div class="stack" class:editing>
      <div class="roll-wrap" class:multi>
        <PianoRoll
          {notes}
          {chords}
          {cropStart}
          {cropEnd}
          {duration}
          {currentTime}
          {playing}
          {editing}
          {offset}
          {view}
          bind:selection
          {onseek}
          onchange={commit}
          onpreview={(pitch) => synth.preview(pitch)}
          onchordtap={playChord}
        />
        <button
          class="pencil"
          class:on={editing}
          onclick={toggleEditing}
          disabled={!hasTranscription || transcribing}
          aria-pressed={editing}
          aria-label={editing ? 'Done editing notes' : 'Edit notes'}
          title={editing ? 'Done' : 'Edit notes'}
        >
          <Icon name={editing ? 'check' : 'edit'} size={17} />
        </button>
      </div>
      <Waveform
        path={live.analysisPath}
        {duration}
        {currentTime}
        {offset}
        {cropStart}
        {cropEnd}
        flush
        onseek={(t) => onseek(t)}
        {oncropchange}
      />
    </div>
  {/if}
</section>

{#if showRetranscribe}
  <Sheet title="Transcribe again" onclose={() => (showRetranscribe = false)}>
    <div class="retranscribe">
      <TranscriptionSettings />
      {#if retranscribeDiscards}
        <p class="confirm-text">
          A new transcription replaces your note corrections on this take. The recording itself is never changed.
        </p>
      {/if}
      <div class="confirm-actions">
        <button class="pill-button primary" onclick={retranscribe}>Transcribe again</button>
        <button class="pill-button" onclick={() => (showRetranscribe = false)}>Cancel</button>
      </div>
    </div>
  </Sheet>
{/if}

{#if confirmation}
  {@const c = confirmation}
  <Sheet title={c.title} onclose={() => (confirmation = null)}>
    <p class="confirm-text">{c.message}</p>
    <div class="confirm-actions">
      <button
        class="pill-button {c.danger ? 'danger' : 'primary'}"
        onclick={async () => {
          confirmation = null;
          try {
            await c.run();
          } catch (error) {
            app.toast(errorMessage(error), 'error');
          }
        }}>{c.action}</button
      >
      <button class="pill-button" onclick={() => (confirmation = null)}>Cancel</button>
    </div>
  </Sheet>
{/if}

<style>
  .track {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .track-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    padding: 2px 0;
  }
  .collapse :global(svg) {
    transition: transform 160ms ease;
  }
  .collapsed .collapse :global(svg) {
    transform: rotate(-90deg);
  }
  .track-name {
    flex: 0 1 auto;
    min-width: 3ch;
    width: 9ch;
    font-weight: 600;
    font-size: 0.95rem;
    border: none;
    background: transparent;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    text-overflow: ellipsis;
  }
  .track-name:hover,
  .track-name:focus {
    background: var(--paper-sunk);
    outline: none;
  }
  .take-chip {
    flex: none;
    font-size: 0.72rem;
    color: var(--ink-3);
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--rule);
  }
  .chord-now {
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--chord);
    min-width: 2ch;
    padding-left: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mini-status {
    font-size: 0.75rem;
    color: var(--ink-3);
  }
  .spacer {
    flex: 1;
  }
  .toggles {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .toggle {
    width: 30px;
    height: 26px;
    border-radius: 7px;
    border: 1px solid var(--rule-strong);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--ink-2);
    display: grid;
    place-items: center;
  }
  .toggle.mute[aria-pressed='true'] {
    background: var(--ink-2);
    border-color: var(--ink-2);
    color: var(--paper);
  }
  .toggle.solo[aria-pressed='true'] {
    background: var(--chord);
    border-color: var(--chord);
    color: var(--paper);
  }
  .rec-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.55;
  }
  .toggle.arm[aria-pressed='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  .toggle.arm[aria-pressed='true'] .rec-dot {
    opacity: 1;
    animation: armed 1s ease-in-out infinite alternate;
  }
  @keyframes armed {
    to {
      opacity: 0.4;
    }
  }
  .muted .stack {
    opacity: 0.55;
  }
  .armed .stack {
    box-shadow: 0 0 0 2px var(--accent);
  }

  .menu-anchor {
    position: relative;
    flex: none;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 40px;
    z-index: 20;
    width: min(270px, calc(100vw - 24px));
    display: grid;
    padding: 6px;
    border-radius: var(--radius);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
    box-shadow: var(--shadow);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .menu button:hover:not(:disabled) {
    background: var(--paper-sunk);
  }
  .menu .danger {
    color: var(--accent);
  }
  .menu-label {
    padding: 4px 10px 2px;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .menu-sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--rule);
  }
  .menu .check {
    width: 16px;
    display: inline-grid;
    color: var(--accent);
  }
  .menu .dim,
  .nudge .dim {
    color: var(--ink-3);
    font-size: 0.8rem;
    margin-left: auto;
  }
  .nudge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    font-size: 0.9rem;
  }
  .nudge .dim {
    margin-left: 0;
    min-width: 6ch;
    text-align: center;
  }
  .nudge span:first-child {
    flex: 1;
  }
  .nudge button {
    padding: 6px;
  }
  .menu-info {
    margin: 2px 10px 6px;
    font-size: 0.78rem;
    color: var(--ink-3);
  }

  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: space-between;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--paper-sunk);
    font-size: 0.9rem;
    color: var(--ink-2);
  }
  .banner.warn {
    color: var(--warn);
  }
  .progress {
    flex-basis: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--rule);
    overflow: hidden;
  }
  .progress div {
    height: 100%;
    background: var(--note);
    transition: width 200ms ease;
  }

  /* The roll and its waveform form one block. */
  .stack {
    display: grid;
    border: 1px solid var(--rule);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--paper-raised);
    min-width: 0;
  }
  .stack.editing {
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .stack :global(.roll) {
    border: none;
    border-radius: 0;
    border-bottom: 1px solid var(--rule);
  }
  .stack.compact :global(.roll) {
    border-bottom: none;
    min-height: 0;
  }
  .roll-wrap {
    position: relative;
    height: clamp(240px, 44vh, 560px);
  }
  .roll-wrap.multi {
    height: clamp(200px, 32vh, 440px);
  }
  .roll-wrap.compact {
    height: 44px;
  }
  /* The pencil sits in the corner above the keyboard. */
  .pencil {
    position: absolute;
    left: 4px;
    top: 5px;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: var(--ink-2);
    background: var(--paper-raised);
    border: 1px solid var(--rule);
  }
  .pencil.on {
    color: var(--paper);
    background: var(--accent);
    border-color: var(--accent);
  }
  .pencil:disabled {
    opacity: 0.4;
  }

  .edit-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--rule);
    margin: 0 4px;
  }
  .save-state {
    font-size: 0.8rem;
    color: var(--ink-3);
    padding-right: 6px;
  }
  .edit-help {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 0 4px;
    min-height: 1.6em;
    font-size: 0.8rem;
    color: var(--ink-3);
  }
  .selection-count {
    color: var(--accent);
    font-weight: 600;
  }
  .join {
    min-height: 32px;
    padding: 0 10px;
    font-size: 0.85rem;
  }
  .link {
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    font-size: 0.82rem;
  }
  .confirm-text {
    margin: 0 0 16px;
    color: var(--ink-2);
  }
  .confirm-actions {
    display: flex;
    gap: 8px;
  }
  .retranscribe {
    display: grid;
    gap: 16px;
  }
  .retranscribe .confirm-text {
    margin: 0;
  }

  @media (orientation: landscape) and (max-height: 540px) {
    .roll-wrap:not(.compact) {
      height: 62vh;
    }
  }
</style>
