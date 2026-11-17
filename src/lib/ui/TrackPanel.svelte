<script lang="ts" module>
  /** What a track plays: its recording, its notes (the synth), or both. */
  export type { ListenMode } from '../library/types';
</script>

<script lang="ts">
  /**
   * A sketch's recording: the piano roll, its chords and the waveform, as one
   * block, with a menu (transcribe again, revert edits). Editing the notes
   * happens here. (On this branch a sketch has one recording; the tracks of
   * the storage layer are not shown.)
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { Sketch, SketchDetail } from '../library/types';
  import { chordVoicing, detectChords, type ChordSegment } from '../music/chords';
  import { notesToMidi } from '../music/midi';
  import { normalizeNote, sortNotes } from '../music/notes';
  import { auditionNotes, canJoin, joinNotes, shiftNotes, type NoteShift } from '../music/selection';
  import { summarize } from '../music/summary';
  import type { NoteSynth } from '../music/synth';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import { environmentName, type Environment, type HeldNotes } from '../transcription/settings';
  import type { PianoNote } from '../transcription/types';
  import ChordStrip from './ChordStrip.svelte';
  import Icon from './Icon.svelte';
  import PianoRoll from './PianoRoll.svelte';
  import type { RollViewport } from './rollViewport.svelte';
  import Sheet from './Sheet.svelte';
  import TranscriptionSettings from './TranscriptionSettings.svelte';
  import Waveform from './Waveform.svelte';

  interface Props {
    /** The recording (its row in the library). */
    take: Sketch;
    sketchTitle: string;
    /** Length of the sketch's timeline (seconds). */
    duration: number;
    currentTime: number;
    playing: boolean;
    cropStart: number | null;
    cropEnd: number | null;
    view: RollViewport;
    synth: NoteSynth;
    onseek: (time: number) => void;
    oncropchange: (start: number, end: number, done: boolean) => void;
    /** The notes changed (loaded, transcribed or edited), in the take's own time. */
    onnotes: (notes: PianoNote[]) => void;
    /** A chord's symbol as the sketch shows it (spelled for its key). */
    spell?: (chord: ChordSegment) => string;
    /** A passage of the recording (its own time, seconds) for the sample library: add it, or hear it. */
    onaddsample?: (from: number, to: number) => void | Promise<void>;
    onpreviewsample?: (from: number, to: number) => void;
    /** Choose what the notes play with (the piano or a library sample). */
    onchoosesample?: () => void;
    /** The library sample the notes play with, by name (null: the piano). */
    noteSampleName?: string | null;
  }

  let {
    take,
    sketchTitle,
    duration,
    currentTime,
    playing,
    cropStart,
    cropEnd,
    view,
    synth,
    onseek,
    oncropchange,
    onnotes,
    spell,
    onaddsample,
    onpreviewsample,
    onchoosesample,
    noteSampleName = null,
  }: Props = $props();

  // ------------------------------------------------------------ data
  let detail = $state<SketchDetail | null>(null);
  // Replaced wholesale on every edit; raw keeps object identity (selection, undo).
  let notes = $state.raw<PianoNote[]>([]);

  // ---------------------------------------------------------- editing
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
  /** The roll is always editable, once there are notes to edit and none are on the way. */
  const editing = $derived(hasTranscription && !transcribing);
  const chords = $derived(detectChords(notes));

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
    audition(auditionNotes(changed, currentTime - offset));
  }

  /** Moved notes, heard: those at the playhead, else those at the start of the selection. */
  function audition(heard: PianoNote[]) {
    if (heard.length === 0) return;
    const velocity = heard.reduce((sum, n) => sum + n.velocity, 0) / heard.length;
    synth.unlock();
    synth.playChord(
      heard.map((n) => n.pitch),
      Math.max(60, Math.round(velocity)),
      0.55,
      0,
    );
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
    const at = Math.max(0, currentTime - offset);
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

  // ------------------------------------------------------------ actions

  function retranscribe() {
    showMenu = false;
    showRetranscribe = false;
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

</script>

<svelte:window onkeydown={onKey} />

<section class="track" aria-label="Recording">
  <header class="track-bar">
    <span class="spacer"></span>
    <div class="menu-anchor">
      <button class="icon-button" onclick={() => (showMenu = !showMenu)} aria-label="Recording actions" aria-expanded={showMenu}>
        <Icon name="more" />
      </button>
      {#if showMenu}
        <div class="menu" role="menu">
          <button role="menuitem" onclick={askRetranscribe} disabled={transcribing}>
            <Icon name="refresh" size={18} /> {hasTranscription ? 'Transcribe again' : 'Transcribe'}
          </button>
          {#if onchoosesample}
            <button role="menuitem" onclick={() => ((showMenu = false), onchoosesample?.())}>
              <Icon name="samples" size={18} /> Use sample…{#if noteSampleName}<span class="menu-note">{noteSampleName}</span>{/if}
            </button>
          {/if}
          {#if detail?.hasEdits}
            <button role="menuitem" onclick={revertEdits}><Icon name="undo" size={18} /> Revert note edits</button>
          {/if}
          {#if transcribedWith || detail?.transcription}
            <p class="menu-info">
              {#if detail?.transcription}Transcribed by {detail.transcription.engine} {detail.transcription.engineVersion}{/if}{#if transcribedWith}, for {transcribedWith}{/if}
            </p>
          {/if}
        </div>
      {/if}
    </div>
  </header>

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
      <!-- The selection, and selecting all or none (one line kept, so the roll does not move when notes are selected). -->
      <p class="selection-line">
        {#if hasSelection}
          <span class="selection-count" aria-live="polite"
            >{selectedIndices.length} {selectedIndices.length === 1 ? 'note' : 'notes'} selected</span
          >
          <button class="link" onclick={() => (selection = [])}>Deselect</button>
        {/if}
        {#if notes.length > 0 && selectedIndices.length < notes.length}<button class="link" onclick={selectAll}>Select all</button>{/if}
      </p>
    {/if}

    <div class="stack">
      <div class="roll-wrap">
        <PianoRoll
          {notes}
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
          onaudition={audition}
        />
      </div>
      <ChordStrip
        {chords}
        {offset}
        {currentTime}
        {view}
        {spell}
        empty={hasTranscription ? 'No chords found' : ''}
        onchordtap={playChord}
      />
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
        onaddsample={onaddsample ? (start, end) => onaddsample(start - offset, end - offset) : undefined}
        onpreviewsample={onpreviewsample ? (start, end) => onpreviewsample(start - offset, end - offset) : undefined}
      />
    </div>

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
          // Read before closing: `c` follows `confirmation`.
          const run = c.run;
          confirmation = null;
          try {
            await run();
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
    margin-bottom: -6px;
  }
  .spacer {
    flex: 1;
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
  .menu-note {
    margin-left: auto;
    max-width: 8em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.78rem;
    color: var(--ink-3);
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
  .stack :global(.roll) {
    border: none;
    border-radius: 0;
    border-bottom: 1px solid var(--rule);
  }
  .roll-wrap {
    position: relative;
    height: clamp(240px, 44vh, 560px);
  }

  /* Always shown now (the roll is always editing): one row, scrolled sideways on a narrow phone. */
  .edit-toolbar {
    display: flex;
    align-items: center;
    gap: 0;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .edit-toolbar::-webkit-scrollbar {
    display: none;
  }
  .edit-toolbar > * {
    flex: none;
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
  .selection-line {
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
    .roll-wrap {
      height: 62vh;
    }
  }
</style>
