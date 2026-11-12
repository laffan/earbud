<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { SketchDetail } from '../library/types';
  import { chordVoicing, detectChords, type ChordSegment } from '../music/chords';
  import { notesToMidi } from '../music/midi';
  import { normalizeNote, notesEndTime, sortNotes } from '../music/notes';
  import { canJoin, joinNotes, shiftNotes, type NoteShift } from '../music/selection';
  import { summarize } from '../music/summary';
  import { NoteSynth } from '../music/synth';
  import { MediaTransport } from '../playback/transport';
  import { errorMessage, fileUrl } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import { environmentName, type Environment, type HeldNotes } from '../transcription/settings';
  import type { PianoNote } from '../transcription/types';
  import Icon from './Icon.svelte';
  import PianoRoll from './PianoRoll.svelte';
  import Sheet from './Sheet.svelte';
  import TranscriptionSettings from './TranscriptionSettings.svelte';
  import Waveform from './Waveform.svelte';
  import { displayTitle, formatClock, formatDate, formatDuration, formatTimeOfDay } from './format';

  let { id }: { id: string } = $props();

  // ------------------------------------------------------------ data
  let detail = $state<SketchDetail | null>(null);
  let loadError = $state<string | null>(null);
  // Replaced wholesale on every edit; raw keeps object identity (selection,
  // undo) and avoids proxying thousands of notes.
  let notes = $state.raw<PianoNote[]>([]);
  let title = $state('');
  let textNotes = $state('');

  // ---------------------------------------------------------- editing
  let editing = $state(false);
  /** Indices (into `notes`) of the notes selected in the editor. */
  let selection = $state<number[]>([]);
  let undoStack: PianoNote[][] = [];
  let redoStack: PianoNote[][] = [];
  let canUndo = $state(false);
  let canRedo = $state(false);
  let dirty = false;
  let saveTimer: number | undefined;
  let notesTimer: number | undefined;
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // --------------------------------------------------------- playback
  let video = $state<HTMLVideoElement | null>(null);
  let currentTime = $state(0);
  let mediaDuration = $state(0);
  let playing = $state(false);
  let rate = $state(1);
  let listen = $state<'recording' | 'notes' | 'both'>('recording');
  let sources = $state<string[]>([]);
  let sourceIndex = $state(0);
  let mediaNotice = $state<string | null>(null);
  let blobUrl: string | null = null;
  const BLOB_FALLBACK_LIMIT = 200 * 1024 * 1024;
  let buffering = $state(false);
  /** Playback crop range in seconds (null = whole take). */
  let cropStart = $state<number | null>(null);
  let cropEnd = $state<number | null>(null);
  let loopPlayback = $state(false);
  const synth = new NoteSynth();

  /**
   * One clock for the video, the waveform, the piano roll and the synth.
   * `currentTime` and `playing` below always come from it.
   */
  const transport = new MediaTransport({
    onState: (state) => {
      currentTime = state.position;
      buffering = state.buffering;
      if (state.playing !== playing) {
        playing = state.playing;
        if (playing && listen !== 'recording') void synth.start(state.position, rate);
        if (!playing) synth.stop();
      }
    },
    onFrame: (position, playbackRate) => {
      if (listen !== 'recording') synth.tick(position, playbackRate);
    },
    onJump: (position) => {
      if (listen !== 'recording') void synth.start(position, rate);
    },
    onError: (message) => app.toast(message, 'error'),
    log: (message) => app.logCapture(`[playback] ${message}`),
  });

  $effect(() => {
    transport.attach(video);
  });
  $effect(() => {
    transport.setRange(cropStart ?? 0, cropEnd);
  });
  $effect(() => {
    transport.setLoop(loopPlayback);
  });

  // --------------------------------------------------------------- ui
  let roll = $state<ReturnType<typeof PianoRoll> | null>(null);
  let showMenu = $state(false);
  /** The "Transcribe again" sheet (environment and held-note choices). */
  let showRetranscribe = $state(false);
  /** Transcribing again would discard note corrections (shown in that sheet). */
  let retranscribeDiscards = $state(false);
  let confirmation = $state<{
    title: string;
    message: string;
    action: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);

  const live = $derived(app.sketches.find((s) => s.id === id) ?? detail);
  const job = $derived(app.jobs[id]);
  const transcribing = $derived(!!job || live?.transcriptionStatus === 'running');
  const hasTranscription = $derived(!!detail?.transcription);
  const chords = $derived(detectChords(notes));
  const duration = $derived(
    mediaDuration || (detail?.durationMs ? detail.durationMs / 1000 : 0) || notesEndTime(notes),
  );
  const currentChord = $derived(chords.find((c) => currentTime >= c.startTime && currentTime < c.endTime));

  // ------------------------------------------------------------- load

  function workingNotes(d: SketchDetail): PianoNote[] {
    const t = d.transcription;
    return sortNotes(t ? (t.editedNotes ?? t.originalNotes) : []);
  }

  async function load() {
    try {
      const d = await app.library.get(id);
      detail = d;
      title = d.title;
      textNotes = d.textNotes;
      notes = workingNotes(d);
      synth.setNotes(notes);
      cropStart = d.cropStartMs !== null ? d.cropStartMs / 1000 : null;
      cropEnd = d.cropEndMs !== null ? d.cropEndMs / 1000 : null;
      if (d.mediaPath) {
        sources = [fileUrl(d.mediaPath)];
        sourceIndex = 0;
      }
    } catch (error) {
      loadError = errorMessage(error);
    }
  }

  /** Pick up results from the processing queue (without clobbering edits). */
  async function refresh() {
    try {
      const d = await app.library.get(id);
      detail = d;
      if (!dirty) {
        notes = workingNotes(d);
        // An autosave lands here with the same notes: keep the selection.
        selection = selection.filter((i) => i < notes.length);
        synth.setNotes(notes);
      }
    } catch {
      // deleted
    }
  }

  let seenRevision = untrack(() => app.revision[id] ?? 0);
  $effect(() => {
    const revision = app.revision[id] ?? 0;
    if (revision !== seenRevision) {
      seenRevision = revision;
      untrack(() => void refresh());
    }
  });

  onMount(() => {
    void load();
    // Note: do not set `navigator.audioSession.type` here. On iOS it makes
    // WebKit hold its own (separate-process) playback session, which then
    // fights the native recorder's session and ends recordings at once. The
    // native plugin already sets the app's category to `.playback`.
  });

  onDestroy(() => {
    window.clearTimeout(notesTimer);
    if (detail && textNotes !== detail.textNotes) void app.saveNotesText(id, textNotes);
    void saveNow();
    transport.dispose();
    synth.dispose();
    // Release the media pipeline (and WebKit's audio session) right away
    // instead of waiting for garbage collection.
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });

  // --------------------------------------------------------- playback

  $effect(() => {
    if (video) video.muted = listen === 'notes';
  });

  function onMetadata() {
    if (!video) return;
    if (video.duration === Infinity) {
      // MediaRecorder WebM files have no duration until scanned once.
      const reset = () => {
        video?.removeEventListener('durationchange', reset);
        if (video) video.currentTime = 0;
      };
      video.addEventListener('durationchange', reset);
      video.currentTime = 1e101;
      return;
    }
    mediaDuration = Number.isFinite(video.duration) ? video.duration : 0;
  }

  async function onMediaError() {
    const d = detail;
    if (!d || !d.mediaPath) return;
    const original = fileUrl(d.mediaPath);
    app.logCapture(
      `[playback] source ${sourceIndex} failed (code ${video?.error?.code ?? '?'} ${video?.error?.message ?? ''}); trying the next one`,
    );
    // Some WebKit builds cannot stream media from a custom URL scheme:
    // retry from an in-memory blob, then fall back to the analysis audio.
    if (sources[sourceIndex] === original && !original.startsWith('blob:')) {
      try {
        // Only buffer files that comfortably fit in memory.
        const probe = await fetch(original, { headers: { Range: 'bytes=0-0' } });
        const size = Number(probe.headers.get('content-range')?.split('/')[1] ?? NaN);
        const response = size < BLOB_FALLBACK_LIMIT ? await fetch(original) : null;
        if (response?.ok) {
          blobUrl = URL.createObjectURL(await response.blob());
          sources = [...sources, blobUrl];
          sourceIndex = sources.length - 1;
          return;
        }
      } catch {
        // fall through
      }
    }
    if (d.analysisPath) {
      const audio = fileUrl(d.analysisPath);
      if (!sources.includes(audio)) {
        sources = [...sources, audio];
        sourceIndex = sources.length - 1;
        mediaNotice = 'The video cannot be played here, so you are hearing the extracted audio.';
        return;
      }
    }
    mediaNotice = 'This recording cannot be played on this device. It is still saved and can be exported.';
  }

  function togglePlay() {
    transport.toggle();
  }

  function seek(t: number) {
    transport.seek(t);
  }

  /** Tapping a chord plays it (the voicing from the take where possible). */
  function playChord(chord: ChordSegment) {
    synth.playChord(chordVoicing(chord, notes));
    if (!playing) seek(chord.startTime);
  }

  function cycleRate() {
    rate = rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1;
    if (video) {
      video.playbackRate = rate;
      (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
    if (playing && listen !== 'recording') void synth.start(currentTime, rate);
  }

  function setListen(mode: typeof listen) {
    listen = mode;
    if (mode === 'recording') synth.stop();
    else if (playing) void synth.start(currentTime, rate);
  }

  // ------------------------------------------------------------ crop

  const cropped = $derived(cropStart !== null || cropEnd !== null);

  function onCropChange(start: number, end: number, done: boolean) {
    const whole = start <= 0.05 && end >= duration - 0.05;
    cropStart = whole ? null : start;
    cropEnd = whole ? null : end;
    if (done) void saveCrop();
  }

  function clearCrop() {
    cropStart = null;
    cropEnd = null;
    void saveCrop();
  }

  async function saveCrop() {
    try {
      const updated = await app.library.setCrop(
        id,
        cropStart === null ? null : Math.round(cropStart * 1000),
        cropEnd === null ? null : Math.round(cropEnd * 1000),
      );
      app.upsert(updated);
    } catch (error) {
      app.toast(`Could not save the crop: ${errorMessage(error)}`, 'error');
    }
  }

  // ---------------------------------------------------------- editing

  function updateHistory() {
    canUndo = undoStack.length > 0;
    canRedo = redoStack.length > 0;
  }

  function afterChange() {
    updateHistory();
    synth.setNotes(notes);
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

  /** Move, transpose or resize every selected note by the same amount. */
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

  /** Turn selected fragments of the same pitch into one note each. */
  function joinSelected() {
    const result = joinNotes(notes, selectedIndices);
    if (result) commit(result.notes, result.selected);
  }

  function selectAll() {
    selection = notes.map((_, i) => i);
  }

  function addNote() {
    const sounding = notes.filter((n) => n.startTime <= currentTime && n.endTime > currentTime);
    const pitch = sounding.length ? Math.max(...sounding.map((n) => n.pitch)) + 2 : 60;
    const n = normalizeNote({ pitch, startTime: currentTime, endTime: currentTime + 0.5, velocity: 80, confidence: 1 });
    commit([...notes, n], [n]);
    synth.preview(n.pitch);
  }

  async function saveNow() {
    window.clearTimeout(saveTimer);
    if (!dirty || !detail?.transcription) return;
    const snapshot = notes;
    dirty = false;
    try {
      const d = await app.library.saveEdits({ id, notes: snapshot, summary: summarize(snapshot) });
      detail = d;
      app.upsert(d);
      await app.library.writeFile(id, 'midi', notesToMidi(snapshot, { title: title || undefined }));
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

  // ------------------------------------------------------------ actions

  async function saveTitle() {
    if (!detail || title.trim() === detail.title) return;
    try {
      await app.rename(id, title);
      detail = { ...detail, title: title.trim() };
    } catch (error) {
      app.toast(`Could not rename: ${errorMessage(error)}`, 'error');
    }
  }

  function onNotesInput() {
    window.clearTimeout(notesTimer);
    notesTimer = window.setTimeout(async () => {
      if (!detail) return;
      try {
        await app.saveNotesText(id, textNotes);
        detail = { ...detail, textNotes };
      } catch (error) {
        app.toast(`Could not save notes: ${errorMessage(error)}`, 'error');
      }
    }, 600);
  }

  /** Start a (new) transcription with the current settings. */
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
    app.transcribe(id);
  }

  /** Transcribing again first asks where the take was recorded. */
  function askRetranscribe() {
    showMenu = false;
    if (hasTranscription) {
      retranscribeDiscards = !!detail?.hasEdits || dirty;
      showRetranscribe = true;
    } else retranscribe();
  }

  /** How the current notes were made, e.g. "Noisy room, held notes joined". */
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
      message: 'Your note corrections will be discarded. The recording is not affected.',
      action: 'Revert',
      danger: true,
      run: async () => {
        const original = detail?.transcription?.originalNotes;
        if (!original) return;
        window.clearTimeout(saveTimer);
        dirty = false;
        const d = await app.library.resetEdits(id, summarize(original));
        detail = d;
        app.upsert(d);
        notes = sortNotes(original);
        undoStack = [];
        redoStack = [];
        selection = [];
        updateHistory();
        synth.setNotes(notes);
        await app.library.writeFile(id, 'midi', notesToMidi(notes, { title: title || undefined }));
      },
    };
  }

  function deleteSketch() {
    showMenu = false;
    confirmation = {
      title: 'Delete this sketch?',
      message: 'The recording, its transcription and your notes will be permanently removed from this device.',
      action: 'Delete',
      danger: true,
      run: () => app.deleteSketch(id),
    };
  }

  async function exportSketch() {
    // Make sure the latest edits are in the MIDI / notes audio.
    await saveNow();
    app.shareSketches([id]);
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      void togglePlay();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="sketch-view">
  <header class="bar">
    <button class="icon-button" onclick={() => app.goHome()} aria-label="Back to sketches">
      <Icon name="back" />
    </button>
    {#if detail}
      <input
        class="title-input serif"
        bind:value={title}
        placeholder={displayTitle({ title: '', createdAt: detail.createdAt })}
        aria-label="Title"
        maxlength="120"
        onblur={saveTitle}
        onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <button class="icon-button" onclick={exportSketch} aria-label="Share">
        <Icon name="share" />
      </button>
      <div class="menu-anchor">
        <button class="icon-button" onclick={() => (showMenu = !showMenu)} aria-label="More actions" aria-expanded={showMenu}>
          <Icon name="more" />
        </button>
        {#if showMenu}
          <div class="menu" role="menu">
            <button role="menuitem" onclick={askRetranscribe} disabled={transcribing}>
              <Icon name="refresh" size={18} /> {hasTranscription ? 'Transcribe again' : 'Transcribe'}
            </button>
            {#if detail.hasEdits}
              <button role="menuitem" onclick={revertEdits}><Icon name="undo" size={18} /> Revert note edits</button>
            {/if}
            <button role="menuitem" class="danger" onclick={deleteSketch}><Icon name="trash" size={18} /> Delete sketch</button>
          </div>
        {/if}
      </div>
    {/if}
  </header>

  {#if loadError}
    <p class="notice">This sketch could not be opened: {loadError}</p>
  {:else if detail}
    <div class="content">
      <!-- 1. Notes: status, piano roll, editing, chords -->
      <section class="roll-section" aria-label="Transcription">
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
        {:else if live?.transcriptionStatus === 'failed'}
          <div class="banner warn">
            <span>Transcription failed: {live.transcriptionError ?? 'unknown error'}. The recording is safe.</span>
            <button class="pill-button" onclick={retranscribe}>Try again</button>
          </div>
        {:else if !hasTranscription}
          <div class="banner">
            <span>Not transcribed yet.</span>
            <button class="pill-button" onclick={retranscribe}>Transcribe</button>
          </div>
        {/if}

        <div class="roll-toolbar">
          <span class="chord-now serif" aria-live="polite">{currentChord?.symbol ?? ''}</span>
          <span class="spacer"></span>
          <button class="icon-button" onclick={() => roll?.zoom(1 / 1.5)} aria-label="Zoom out"><Icon name="zoom-out" /></button>
          <button class="icon-button" onclick={() => roll?.zoom(1.5)} aria-label="Zoom in"><Icon name="zoom-in" /></button>
          <button
            class="pill-button"
            class:primary={editing}
            onclick={toggleEditing}
            disabled={!hasTranscription || transcribing}
            aria-pressed={editing}
          >
            {#if editing}<Icon name="check" size={16} /> Done{:else}<Icon name="edit" size={16} /> Edit notes{/if}
          </button>
        </div>

        <div class="roll-wrap" class:editing>
          <PianoRoll
            bind:this={roll}
            {notes}
            {chords}
            {cropStart}
            {cropEnd}
            {duration}
            {currentTime}
            {playing}
            {editing}
            bind:selection
            onseek={(t) => seek(t)}
            onchange={commit}
            onpreview={(pitch) => synth.preview(pitch)}
            onchordtap={playChord}
          />
        </div>

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
              Tap a note to select it, or drag across the roll to select several. Drag a selected note to move the
              selection, drag an end to resize, double-tap to add. Scroll with two fingers or by dragging the time ruler.
            {/if}
          </p>
        {/if}

        {#if chords.length > 0}
          <div class="chord-strip" aria-label="Chords (tap to hear)">
            {#each chords as chord, i (i)}
              <button
                class="chord serif"
                class:current={chord === currentChord}
                onclick={() => playChord(chord)}
                title="{formatClock(chord.startTime)} · confidence {Math.round(chord.confidence * 100)}%"
                >{chord.symbol}</button
              >
            {/each}
          </div>
        {/if}
      </section>

      <!-- 2. Waveform scrubber + transport -->
      <section class="playback" aria-label="Playback">
        <Waveform
          path={detail.analysisPath}
          {duration}
          {currentTime}
          {cropStart}
          {cropEnd}
          onseek={(t) => seek(t)}
          oncropchange={onCropChange}
        />
        <div class="transport">
          <button class="play" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <span class="time tabular"
            >{formatClock(currentTime)}<span class="dim"> / {formatClock(duration)}</span
            >{#if buffering}<span class="buffering" aria-live="polite"> loading…</span>{/if}</span
          >
          <span class="spacer"></span>
          <div class="segmented" role="group" aria-label="Listen to">
            <button aria-pressed={listen === 'recording'} onclick={() => setListen('recording')}>Take</button>
            <button aria-pressed={listen === 'notes'} onclick={() => setListen('notes')} disabled={notes.length === 0}
              >Notes</button
            >
            <button aria-pressed={listen === 'both'} onclick={() => setListen('both')} disabled={notes.length === 0}
              >Both</button
            >
          </div>
          <button
            class="icon-button loop"
            class:on={loopPlayback}
            onclick={() => (loopPlayback = !loopPlayback)}
            aria-pressed={loopPlayback}
            aria-label="Loop"
            title="Loop"
          >
            <Icon name="loop" size={18} />
          </button>
          <button class="pill-button rate tabular" onclick={cycleRate} aria-label="Playback speed">{rate}×</button>
        </div>
        {#if cropped}
          <div class="crop-info">
            <span class="tabular">Playing {formatClock(cropStart ?? 0)}–{formatClock(cropEnd ?? duration)}</span>
            <button class="link" onclick={clearCrop}>Play the whole take</button>
          </div>
        {/if}
      </section>

      <!-- 3. The take -->
      <section class="take" aria-label="Recording">
        <div class="media" class:audio-only={!detail.hasVideo || mediaNotice !== null}>
          {#if sources.length > 0}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={video}
              src={sources[sourceIndex]}
              playsinline
              preload="auto"
              onloadedmetadata={onMetadata}
              ondurationchange={() => video && Number.isFinite(video.duration) && (mediaDuration = video.duration)}
              onerror={onMediaError}
              onclick={togglePlay}
            ></video>
          {/if}
          {#if !detail.hasVideo || mediaNotice}
            <div class="audio-badge"><Icon name="mic" size={16} /> Audio-only take</div>
          {/if}
        </div>
        {#if mediaNotice}<p class="notice small">{mediaNotice}</p>{/if}
      </section>

      <!-- 4. Notes and details -->
      <section class="about" aria-label="Notes and details">
        <label class="notes-field">
          <span class="label">Notes</span>
          <textarea
            bind:value={textNotes}
            oninput={onNotesInput}
            rows="4"
            placeholder="What were you going for? Fingering, harmony, ideas for the next take…"
          ></textarea>
        </label>

        <dl class="details">
          <div><dt>Recorded</dt><dd>{formatDate(detail.createdAt)}, {formatTimeOfDay(detail.createdAt)}</dd></div>
          <div><dt>Length</dt><dd class="tabular">{formatDuration(detail.durationMs ?? duration * 1000)}</dd></div>
          <div><dt>Notes</dt><dd class="tabular">{notes.length}{detail.hasEdits ? ' (edited)' : ''}</dd></div>
          {#if detail.transcription}
            <div><dt>Transcribed by</dt><dd>{detail.transcription.engine} {detail.transcription.engineVersion}</dd></div>
            {#if transcribedWith}<div><dt>Transcribed for</dt><dd>{transcribedWith}</dd></div>{/if}
          {/if}
          {#if detail.recovered}<div><dt>Status</dt><dd>Recovered after an interruption</dd></div>{/if}
        </dl>
      </section>
    </div>
  {/if}
</div>

{#if showRetranscribe}
  <Sheet title="Transcribe again" onclose={() => (showRetranscribe = false)}>
    <div class="retranscribe">
      <TranscriptionSettings />
      {#if retranscribeDiscards}
        <p class="confirm-text">
          A new transcription replaces your note corrections. The recording itself is never changed.
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
  .sketch-view {
    min-height: 100vh;
    min-height: 100dvh;
    width: 100%;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 6px) 6px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .title-input {
    flex: 1;
    min-width: 0;
    font-size: 1.15rem;
    font-weight: 600;
    border: none;
    background: transparent;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    text-overflow: ellipsis;
  }
  .title-input:hover,
  .title-input:focus {
    background: var(--paper-sunk);
    outline: none;
  }
  .title-input::placeholder {
    color: var(--ink);
    opacity: 0.85;
  }
  .menu-anchor {
    position: relative;
    flex: none;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 44px;
    width: min(240px, calc(100vw - 24px));
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
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .menu button:hover:not(:disabled) {
    background: var(--paper-sunk);
  }
  .menu .danger {
    color: var(--accent);
  }

  /* One column on phones. Every track is minmax(0, …) so wide content
     (a long chord strip, the toolbar) scrolls inside itself instead of
     widening the page. */
  .content {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
    padding: 10px calc(var(--safe-right) + 12px) calc(var(--safe-bottom) + 40px) calc(var(--safe-left) + 12px);
  }
  .content > section {
    min-width: 0;
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
    margin-bottom: 8px;
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

  .roll-toolbar,
  .edit-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .chord-now {
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--chord);
    min-width: 3ch;
    padding-left: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .roll-wrap {
    height: clamp(240px, 44vh, 560px);
    margin-top: 4px;
  }
  .roll-wrap.editing {
    box-shadow: 0 0 0 2px var(--accent-soft);
    border-radius: var(--radius-sm);
  }
  .edit-toolbar {
    flex-wrap: wrap;
    margin-top: 6px;
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
    margin: 2px 4px 0;
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
  .chord-strip {
    display: flex;
    gap: 6px;
    max-width: 100%;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    padding: 10px 2px 4px;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .chord-strip::-webkit-scrollbar {
    display: none;
  }
  .chord {
    flex: none;
    min-width: 44px;
    min-height: 36px;
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid var(--rule);
    color: var(--chord);
    font-weight: 600;
  }
  .chord:active {
    background: var(--paper-sunk);
  }
  .chord.current {
    border-color: var(--accent);
    color: var(--accent);
  }

  .playback {
    display: grid;
    gap: 8px;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .play {
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--ink);
    color: var(--paper);
  }
  .time {
    font-size: 0.95rem;
    white-space: nowrap;
  }
  .dim {
    color: var(--ink-3);
  }
  .buffering {
    color: var(--ink-3);
    font-size: 0.8rem;
  }
  .spacer {
    flex: 1;
  }
  .rate {
    min-width: 46px;
    padding: 0 8px;
    justify-content: center;
  }
  .loop {
    width: 36px;
    height: 36px;
  }
  .loop.on {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .crop-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 0.82rem;
    color: var(--chord);
  }
  .link {
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    font-size: 0.82rem;
  }
  .transport .segmented button {
    padding: 0 9px;
  }
  @media (max-width: 400px) {
    .transport .segmented button {
      padding: 0 7px;
      font-size: 0.8rem;
    }
    .rate {
      min-width: 40px;
      padding: 0 6px;
    }
  }

  .media {
    position: relative;
    width: 100%;
    border-radius: var(--radius);
    overflow: hidden;
    background: #000;
    display: grid;
    place-items: center;
  }
  .media video {
    display: block;
    width: 100%;
    max-width: 100%;
    height: auto;
    max-height: 50vh;
    object-fit: contain;
    background: #000;
  }
  .media.audio-only {
    background: var(--paper-sunk);
    min-height: 48px;
  }
  .media.audio-only video {
    height: 0;
    max-height: 0;
  }
  .audio-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 14px;
    color: var(--ink-3);
    font-size: 0.9rem;
  }

  .notes-field {
    display: grid;
    gap: 6px;
  }
  .label {
    font-size: 0.78rem;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  textarea {
    width: 100%;
    resize: vertical;
    padding: 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--rule);
    background: var(--paper-raised);
    line-height: 1.5;
    /* Ruled paper. */
    background-image: repeating-linear-gradient(
      to bottom,
      transparent 0 calc(1.5em - 1px),
      color-mix(in srgb, var(--rule) 70%, transparent) calc(1.5em - 1px) 1.5em
    );
    background-position-y: 11px;
  }
  textarea:focus {
    outline: none;
    border-color: var(--rule-strong);
  }
  .details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px 16px;
    margin: 18px 0 0;
    font-size: 0.85rem;
  }
  .details dt {
    color: var(--ink-3);
  }
  .details dd {
    margin: 0;
  }
  .notice {
    margin: 16px;
    color: var(--ink-2);
  }
  .notice.small {
    margin: 8px 2px 0;
    font-size: 0.85rem;
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

  @media (max-width: 430px) {
    .time .dim {
      display: none;
    }
  }

  /* Wide screens: the take and the notes side by side under the roll. */
  @media (min-width: 900px) {
    .content {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        'roll roll'
        'playback playback'
        'take about';
      align-items: start;
    }
    .roll-section {
      grid-area: roll;
    }
    .playback {
      grid-area: playback;
    }
    .take {
      grid-area: take;
    }
    .about {
      grid-area: about;
    }
  }

  /* Phones in landscape: give the roll most of the height. */
  @media (orientation: landscape) and (max-height: 540px) {
    .roll-wrap {
      height: 62vh;
    }
    .media video {
      max-height: 70vh;
    }
  }
</style>
