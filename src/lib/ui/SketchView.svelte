<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { shareFiles } from '../capture';
  import type { SketchDetail } from '../library/types';
  import { detectChords } from '../music/chords';
  import { notesToMidi } from '../music/midi';
  import { normalizeNote, notesEndTime, sortNotes } from '../music/notes';
  import { summarize } from '../music/summary';
  import { NoteSynth } from '../music/synth';
  import { errorMessage, fileUrl, isTauri } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import type { PianoNote } from '../transcription/types';
  import Icon from './Icon.svelte';
  import PianoRoll from './PianoRoll.svelte';
  import Sheet from './Sheet.svelte';
  import { displayTitle, exportBaseName, formatClock, formatDate, formatDuration, formatTimeOfDay } from './format';

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
  let selected = $state<number | null>(null);
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
  let raf = 0;
  const synth = new NoteSynth();

  // --------------------------------------------------------------- ui
  let roll = $state<ReturnType<typeof PianoRoll> | null>(null);
  let showMenu = $state(false);
  let exporting = $state(false);
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
        if (selected !== null && selected >= notes.length) selected = null;
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
    cancelAnimationFrame(raf);
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

  function loop() {
    if (!video) return;
    currentTime = video.currentTime;
    if (listen !== 'recording') synth.tick(video.currentTime, video.playbackRate);
    if (!video.paused) raf = requestAnimationFrame(loop);
  }

  function onPlay() {
    playing = true;
    if (video && listen !== 'recording') void synth.start(video.currentTime, video.playbackRate);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function onPause() {
    playing = false;
    synth.stop();
    if (video) currentTime = video.currentTime;
  }

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

  async function togglePlay() {
    if (!video) return;
    if (video.paused) {
      if (video.ended || (duration > 0 && video.currentTime >= duration - 0.05)) video.currentTime = 0;
      try {
        await video.play();
      } catch (error) {
        app.toast(`Playback failed: ${errorMessage(error)}`, 'error');
      }
    } else {
      video.pause();
    }
  }

  function seek(t: number) {
    currentTime = t;
    if (video) video.currentTime = t;
    if (playing && listen !== 'recording') void synth.start(t, video?.playbackRate ?? 1);
  }

  function cycleRate() {
    rate = rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1;
    if (video) {
      video.playbackRate = rate;
      (video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
  }

  function setListen(mode: typeof listen) {
    listen = mode;
    if (!video) return;
    if (mode === 'recording') synth.stop();
    else if (!video.paused) void synth.start(video.currentTime, video.playbackRate);
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

  function commit(next: PianoNote[], focus: PianoNote | null) {
    undoStack.push(notes);
    if (undoStack.length > 200) undoStack.shift();
    redoStack = [];
    const sorted = sortNotes(next);
    const index = focus ? sorted.indexOf(focus) : -1;
    notes = sorted;
    selected = index >= 0 ? index : null;
    afterChange();
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push(notes);
    notes = previous;
    selected = null;
    afterChange();
  }

  function redo() {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push(notes);
    notes = next;
    selected = null;
    afterChange();
  }

  function modifySelected(change: (n: PianoNote) => PianoNote) {
    if (selected === null || !notes[selected]) return;
    const original = notes[selected];
    const changed = change(original);
    if (changed.startTime < 0) {
      changed.endTime -= changed.startTime;
      changed.startTime = 0;
    }
    const n = normalizeNote(changed, duration + 30);
    const next = notes.slice();
    next[selected] = n;
    commit(next, n);
    if (n.pitch !== original.pitch) synth.preview(n.pitch);
  }

  function deleteSelected() {
    if (selected === null) return;
    const index = selected;
    commit(
      notes.filter((_, i) => i !== index),
      null,
    );
  }

  function addNote() {
    const sounding = notes.filter((n) => n.startTime <= currentTime && n.endTime > currentTime);
    const pitch = sounding.length ? Math.max(...sounding.map((n) => n.pitch)) + 2 : 60;
    const n = normalizeNote({ pitch, startTime: currentTime, endTime: currentTime + 0.5, velocity: 80, confidence: 1 });
    commit([...notes, n], n);
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
      selected = null;
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

  function retranscribe() {
    showMenu = false;
    const go = () => {
      editing = false;
      dirty = false;
      undoStack = [];
      redoStack = [];
      updateHistory();
      app.transcribe(id);
    };
    if (detail?.hasEdits || dirty) {
      confirmation = {
        title: 'Transcribe again?',
        message:
          'A new transcription replaces your note corrections. The recording itself is never changed.',
        action: 'Transcribe again',
        run: go,
      };
    } else go();
  }

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
        selected = null;
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

  function mediaExtension(mime: string | null): string {
    if (!mime) return '.mov';
    if (mime.includes('quicktime')) return '.mov';
    if (mime.includes('webm')) return mime.startsWith('audio') ? '.weba' : '.webm';
    if (mime.startsWith('audio/mp4')) return '.m4a';
    return '.mp4';
  }

  async function exportSketch() {
    if (!detail) return;
    exporting = true;
    try {
      await saveNow();
      if (notes.length > 0) {
        await app.library.writeFile(id, 'midi', notesToMidi(notes, { title: displayTitle({ title, createdAt: detail.createdAt }) }));
      }
      const base = exportBaseName({ title, createdAt: detail.createdAt });
      const bundle = await app.library.prepareExport(id, base);
      const files = [bundle.mediaPath, bundle.midiPath].filter((f): f is string => !!f);
      if (app.capabilities?.nativeShare) {
        await shareFiles(files);
      } else if (isTauri()) {
        const [{ open }, { basename, join }] = await Promise.all([
          import('@tauri-apps/plugin-dialog'),
          import('@tauri-apps/api/path'),
        ]);
        const dir = await open({ directory: true, title: 'Export sketch to folder' });
        if (typeof dir === 'string') {
          for (const file of files) await app.library.copyOut(file, await join(dir, await basename(file)));
          app.toast(`Exported ${files.length === 2 ? 'recording and MIDI' : 'recording'} to ${dir}`);
        }
      } else {
        // Browser preview: download the files.
        const names = [`${base}${mediaExtension(detail.mediaMime)}`, `${base}.mid`];
        files.forEach((href, i) => {
          const a = document.createElement('a');
          a.href = href;
          a.download = names[i];
          a.click();
        });
      }
    } catch (error) {
      app.toast(`Export failed: ${errorMessage(error)}`, 'error');
    } finally {
      exporting = false;
    }
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
      <button class="icon-button" onclick={exportSketch} disabled={exporting} aria-label="Export recording and MIDI">
        <Icon name="share" />
      </button>
      <div class="menu-anchor">
        <button class="icon-button" onclick={() => (showMenu = !showMenu)} aria-label="More actions" aria-expanded={showMenu}>
          <Icon name="more" />
        </button>
        {#if showMenu}
          <div class="menu" role="menu">
            <button role="menuitem" onclick={retranscribe} disabled={transcribing}>
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
      <div class="media-col">
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
              onplay={onPlay}
              onpause={onPause}
              onended={onPause}
              onseeked={() => video && (currentTime = video.currentTime)}
              ontimeupdate={() => !playing && video && (currentTime = video.currentTime)}
              onerror={onMediaError}
              onclick={togglePlay}
            ></video>
          {/if}
          {#if !detail.hasVideo || mediaNotice}
            <div class="audio-badge"><Icon name="mic" size={16} /> Audio</div>
          {/if}
        </div>
        {#if mediaNotice}<p class="notice small">{mediaNotice}</p>{/if}

        <div class="transport">
          <button class="play" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          <span class="time tabular">{formatClock(currentTime)} <span class="dim">/ {formatClock(duration)}</span></span>
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
          <button class="pill-button rate tabular" onclick={cycleRate} aria-label="Playback speed">{rate}×</button>
        </div>
      </div>

      <div class="roll-col">
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
            {duration}
            {currentTime}
            {playing}
            {editing}
            bind:selected
            onseek={seek}
            onchange={commit}
            onpreview={(pitch) => synth.preview(pitch)}
          />
        </div>

        {#if editing}
          <div class="edit-toolbar" role="toolbar" aria-label="Note editing">
            <button class="icon-button" onclick={undo} disabled={!canUndo} aria-label="Undo"><Icon name="undo" /></button>
            <button class="icon-button" onclick={redo} disabled={!canRedo} aria-label="Redo"><Icon name="redo" /></button>
            <span class="sep"></span>
            <button class="icon-button" onclick={addNote} aria-label="Add note at playhead"><Icon name="plus" /></button>
            <button class="icon-button" onclick={deleteSelected} disabled={selected === null} aria-label="Delete note"
              ><Icon name="trash" /></button
            >
            <span class="sep"></span>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, pitch: n.pitch + 1 }))} disabled={selected === null} aria-label="Semitone up"><Icon name="up" /></button>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, pitch: n.pitch - 1 }))} disabled={selected === null} aria-label="Semitone down"><Icon name="down" /></button>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, startTime: n.startTime - 0.05, endTime: n.endTime - 0.05 }))} disabled={selected === null} aria-label="Earlier"><Icon name="left" /></button>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, startTime: n.startTime + 0.05, endTime: n.endTime + 0.05 }))} disabled={selected === null} aria-label="Later"><Icon name="right" /></button>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, endTime: n.endTime - 0.1 }))} disabled={selected === null} aria-label="Shorter"><Icon name="shorter" /></button>
            <button class="icon-button" onclick={() => modifySelected((n) => ({ ...n, endTime: n.endTime + 0.1 }))} disabled={selected === null} aria-label="Longer"><Icon name="longer" /></button>
            <span class="spacer"></span>
            <span class="save-state">
              {#if saveState === 'saving'}Saving…{:else if saveState === 'saved'}Saved{:else if saveState === 'error'}Not saved{/if}
            </span>
          </div>
          <p class="edit-help">Tap a note to select it. Drag to move, drag its end to resize, double-tap to add.</p>
        {/if}

        {#if chords.length > 0}
          <div class="chord-strip" aria-label="Chords">
            {#each chords as chord, i (i)}
              <button
                class="chord serif"
                class:current={chord === currentChord}
                onclick={() => seek(chord.startTime)}
                title="{formatClock(chord.startTime)} · confidence {Math.round(chord.confidence * 100)}%"
                >{chord.symbol}</button
              >
            {/each}
          </div>
        {/if}

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
          {/if}
          {#if detail.recovered}<div><dt>Status</dt><dd>Recovered after an interruption</dd></div>{/if}
        </dl>
      </div>
    </div>
  {/if}
</div>

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
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 8px) 6px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .title-input {
    flex: 1;
    min-width: 0;
    font-size: 1.2rem;
    font-weight: 600;
    border: none;
    background: transparent;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
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
  }
  .menu {
    position: absolute;
    right: 0;
    top: 44px;
    min-width: 220px;
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

  .content {
    display: grid;
    gap: 14px;
    max-width: 1280px;
    margin: 0 auto;
    padding: 12px calc(var(--safe-right) + 14px) calc(var(--safe-bottom) + 40px) calc(var(--safe-left) + 14px);
  }
  .media {
    position: relative;
    border-radius: var(--radius);
    overflow: hidden;
    background: #000;
    display: grid;
    place-items: center;
  }
  .media video {
    width: 100%;
    max-height: 38vh;
    display: block;
    object-fit: contain;
    background: #000;
  }
  .media.audio-only {
    background: var(--paper-sunk);
    min-height: 56px;
  }
  .media.audio-only video {
    height: 0;
    max-height: 0;
  }
  .audio-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 16px;
    color: var(--ink-3);
    font-size: 0.9rem;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
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
  }
  .dim {
    color: var(--ink-3);
  }
  .spacer {
    flex: 1;
  }
  .rate {
    min-width: 46px;
    padding: 0 8px;
    justify-content: center;
  }
  .transport .segmented button {
    padding: 0 9px;
  }
  @media (max-width: 400px) {
    .time .dim {
      display: none;
    }
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
  }
  .chord-now {
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--chord);
    min-width: 3ch;
    padding-left: 4px;
  }
  .roll-wrap {
    height: clamp(240px, 46vh, 560px);
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
    margin: 2px 4px 0;
    font-size: 0.8rem;
    color: var(--ink-3);
  }
  .chord-strip {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding: 10px 2px 4px;
    scrollbar-width: none;
  }
  .chord {
    flex: none;
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid var(--rule);
    color: var(--chord);
    font-weight: 600;
  }
  .chord.current {
    border-color: var(--accent);
    color: var(--accent);
  }
  .notes-field {
    display: grid;
    gap: 6px;
    margin-top: 16px;
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
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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

  /* Side by side on wide screens and on phones in landscape. */
  @media (min-width: 900px), (orientation: landscape) and (max-height: 540px) {
    .content {
      grid-template-columns: minmax(280px, 40%) 1fr;
      align-items: start;
    }
    .media-col {
      position: sticky;
      top: 70px;
    }
    .media video {
      max-height: 62vh;
    }
  }
  @media (orientation: landscape) and (max-height: 540px) {
    .roll-wrap {
      height: 66vh;
    }
  }
</style>
