<script lang="ts">
  /**
   * An open sketch: its tracks (each a piano roll with its waveform), an
   * "Add track" button, the video, text notes and details, and the
   * transport fixed to the bottom of the screen. All tracks play together
   * on one timeline (`TrackMixer`), honouring mute and solo.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { Sketch, SketchDetail, Track, UpdateTrackArgs } from '../library/types';
  import { notesEndTime } from '../music/notes';
  import { NoteSynth } from '../music/synth';
  import { TrackMixer, type MixerTrack } from '../playback/mixer';
  import { TakeSource } from '../playback/takeSource.svelte';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import type { PianoNote } from '../transcription/types';
  import Icon from './Icon.svelte';
  import { RollViewport } from './rollViewport.svelte';
  import Sheet from './Sheet.svelte';
  import TrackPanel from './TrackPanel.svelte';
  import { displayTitle, formatClock, formatDate, formatDuration, formatTimeOfDay } from './format';

  let { id }: { id: string } = $props();

  // ------------------------------------------------------------ data
  let detail = $state<SketchDetail | null>(null);
  let loadError = $state<string | null>(null);
  let title = $state('');
  let textNotes = $state('');
  let notesTimer: number | undefined;
  /** Each take's current notes (its own time), as its track panel reports them. */
  let takeNotes = $state.raw<Record<string, PianoNote[]>>({});

  const tracks = $derived(detail?.tracks ?? []);
  const anySolo = $derived(tracks.some((t) => t.solo));
  const audible = (track: Track) => !track.muted && (!anySolo || track.solo);

  /** The take a track plays, freshest copy first (the queue updates `app.sketches`). */
  function takeOf(track: Track): Sketch | null {
    return app.sketches.find((s) => s.id === track.takeId) ?? track.takes.find((t) => t.id === track.takeId) ?? null;
  }

  /** Tracks whose take can play (not still being recorded), with that take. */
  const playable = $derived(
    tracks
      .map((track) => ({ track, take: takeOf(track) }))
      .filter((e): e is { track: Track; take: Sketch } => !!e.take && e.take.status === 'saved' && !!e.take.mediaPath),
  );
  /** The take shown as video: the first one with video, else the first one (its element is a <video>). */
  const shown = $derived(playable.find((e) => e.take.hasVideo) ?? playable[0] ?? null);

  // --------------------------------------------------------- playback
  let mediaEls = $state<Record<string, HTMLMediaElement | null>>({});
  let mediaDurations = $state<Record<string, number>>({});
  let sources = $state<Record<string, TakeSource>>({});
  let currentTime = $state(0);
  let playing = $state(false);
  let rate = $state(1);
  let listen = $state<'recording' | 'notes' | 'both'>('recording');
  let buffering = $state(false);
  /** Playback crop range in seconds (null = whole sketch). */
  let cropStart = $state<number | null>(null);
  let cropEnd = $state<number | null>(null);
  let loopPlayback = $state(false);
  /** The track armed to record a new take (the R toggle). */
  let armedTrack = $state<string | null>(null);
  /** Recording into this sketch: the track getting a new take, null for a new track, undefined when not. */
  let recordingInto = $state<string | null | undefined>(undefined);
  const synth = new NoteSynth();
  const view = new RollViewport();
  const unlocked = new WeakSet<HTMLMediaElement>();

  /** One clock for every track, the waveforms, the piano rolls and the synth. */
  const mixer = new TrackMixer({
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
    // WebKit can play a file URL it cannot seek in; an in-memory copy can.
    onUnseekable: () => {
      const current = mixer.transport.current;
      const takeId = Object.keys(mediaEls).find((k) => mediaEls[k] === current);
      const source = takeId ? sources[takeId] : undefined;
      void source?.loadIntoMemory().then((switched) =>
        app.logCapture(`[playback] ${switched ? 'playing an in-memory copy so seeking works' : 'no seekable source available'}`),
      );
    },
    log: (message) => app.logCapture(`[playback] ${message}`),
  });

  // Media sources per take, created as takes appear and released as they go.
  $effect(() => {
    const wanted = playable.map((e) => e.take);
    untrack(() => {
      const keep = new Set(wanted.map((t) => t.id));
      for (const take of wanted) {
        if (sources[take.id]) continue;
        const takeId = take.id;
        sources[takeId] = new TakeSource(
          take.mediaPath,
          () => app.sketches.find((s) => s.id === takeId)?.analysisPath ?? take.analysisPath,
          (message) => app.logCapture(`[playback] ${message}`),
        );
      }
      for (const key of Object.keys(sources)) {
        if (!keep.has(key)) {
          sources[key].dispose();
          delete sources[key];
        }
      }
    });
  });

  const mixerTracks = $derived<MixerTrack[]>(
    playable.map(({ track, take }) => ({
      id: track.id,
      media: mediaEls[take.id] ?? null,
      offset: take.offsetMs / 1000,
      duration: mediaDurations[take.id] || (take.durationMs ?? 0) / 1000 || notesEndTime(takeNotes[take.id] ?? []),
      audible: audible(track) && track.id !== recordingInto,
    })),
  );
  $effect(() => {
    const list = mixerTracks;
    untrack(() => mixer.setTracks(list));
  });

  /** Length of the sketch: the end of its latest take (or of its notes). */
  const duration = $derived.by(() => {
    let end = 0;
    for (const track of tracks) {
      const take = takeOf(track);
      if (!take) continue;
      const offset = take.offsetMs / 1000;
      const length = mediaDurations[take.id] || (take.durationMs ?? 0) / 1000;
      end = Math.max(end, offset + length, offset + notesEndTime(takeNotes[take.id] ?? []));
    }
    return end;
  });

  /** The notes the synth plays: every audible track's, on the sketch's timeline. */
  const mixedNotes = $derived(
    playable.flatMap(({ track, take }) => {
      if (!audible(track) || track.id === recordingInto) return [];
      const notes = takeNotes[take.id] ?? [];
      const offset = take.offsetMs / 1000;
      if (offset === 0) return notes;
      return notes
        .filter((n) => n.endTime + offset > 0)
        .map((n) => ({ ...n, startTime: Math.max(0, n.startTime + offset), endTime: n.endTime + offset }));
    }),
  );
  const noteCount = $derived(playable.reduce((sum, e) => sum + (takeNotes[e.take.id]?.length ?? 0), 0));
  const anyEdits = $derived(playable.some((e) => e.take.hasEdits));

  $effect(() => {
    synth.setNotes(mixedNotes);
  });
  $effect(() => {
    // While recording into the sketch the other tracks play to the end: no crop, no loop.
    const overdub = recordingInto !== undefined;
    mixer.setRange(overdub ? 0 : (cropStart ?? 0), overdub ? null : cropEnd);
  });
  $effect(() => {
    mixer.setLoop(loopPlayback && recordingInto === undefined);
  });
  $effect(() => {
    mixer.setSilent(listen === 'notes');
  });

  // --------------------------------------------------------------- ui
  let showMenu = $state(false);
  let confirmation = $state<{
    title: string;
    message: string;
    action: string;
    danger?: boolean;
    run: () => void | Promise<void>;
  } | null>(null);
  let panels = $state<Record<string, ReturnType<typeof TrackPanel> | null>>({});

  // ------------------------------------------------------------- load

  async function load() {
    try {
      const d = await app.library.get(id);
      detail = d;
      title = d.title;
      textNotes = d.textNotes;
      cropStart = d.cropStartMs !== null ? d.cropStartMs / 1000 : null;
      cropEnd = d.cropEndMs !== null ? d.cropEndMs / 1000 : null;
    } catch (error) {
      loadError = errorMessage(error);
    }
  }

  /** Pick up new tracks and takes (the panels reload their own notes). */
  async function refresh() {
    try {
      detail = await app.library.get(id);
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
    mixer.dispose();
    synth.dispose();
    // Release the media pipelines (and WebKit's audio session) right away
    // instead of waiting for garbage collection.
    for (const el of Object.values(mediaEls)) {
      if (!el) continue;
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    for (const source of Object.values(sources)) source.dispose();
  });

  // ------------------------------------------------------------ media

  function onMetadata(takeId: string, el: HTMLMediaElement) {
    if (el.duration === Infinity) {
      // MediaRecorder WebM files have no duration until scanned once.
      const reset = () => {
        el.removeEventListener('durationchange', reset);
        el.currentTime = 0;
      };
      el.addEventListener('durationchange', reset);
      el.currentTime = 1e101;
      return;
    }
    if (Number.isFinite(el.duration)) mediaDurations[takeId] = el.duration;
  }

  function onDurationChange(takeId: string, el: HTMLMediaElement) {
    if (Number.isFinite(el.duration) && el.duration > 0) mediaDurations[takeId] = el.duration;
  }

  /**
   * iOS lets a media element play with sound only after a play() inside a
   * tap. The clock's element gets one from the play button; the other
   * tracks' elements are started later by the mixer, so give each of them
   * one here (played and paused at once).
   */
  function unlockMedia() {
    const clock = mixer.transport.current;
    for (const el of Object.values(mediaEls)) {
      if (!el || el === clock || !el.paused || unlocked.has(el)) continue;
      unlocked.add(el);
      const started = el.play();
      el.pause();
      void started?.catch(() => {});
    }
  }

  function togglePlay() {
    if (!playing) unlockMedia();
    mixer.toggle();
  }

  function seek(t: number) {
    mixer.seek(t);
  }

  function cycleRate() {
    rate = rate === 1 ? 0.75 : rate === 0.75 ? 0.5 : 1;
    mixer.setRate(rate);
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

  // ----------------------------------------------------------- tracks

  const trackLabel = (track: Track) => track.name || `Track ${track.position + 1}`;
  const nextTrackLabel = $derived(`Track ${tracks.reduce((p, t) => Math.max(p, t.position), -1) + 2}`);
  const canRecordTake = $derived(app.canRecord && !app.recording && !!detail && detail.status === 'saved');
  const armed = $derived(tracks.find((t) => t.id === armedTrack) ?? null);

  function replaceTrack(updated: Track) {
    if (!detail) return;
    detail = { ...detail, tracks: detail.tracks.map((t) => (t.id === updated.id ? updated : t)) };
  }

  async function updateTrack(track: Track, patch: Omit<UpdateTrackArgs, 'id'>) {
    // Toggles answer at once; the library confirms.
    const { offsetMs: _offset, takeId: _take, ...simple } = patch;
    replaceTrack({ ...track, ...simple });
    try {
      const updated = await app.library.updateTrack({ id: track.id, ...patch });
      replaceTrack(updated);
      if (patch.offsetMs !== undefined || patch.takeId !== undefined) {
        // The take rows changed (offset, or which one plays).
        for (const take of updated.takes) app.upsert(take);
      }
    } catch (error) {
      app.toast(`Could not change the track: ${errorMessage(error)}`, 'error');
      await refresh();
    }
  }

  function toggleArm(track: Track) {
    armedTrack = armedTrack === track.id ? null : track.id;
  }

  /**
   * Where the other tracks start while a take is recorded: the playhead,
   * but not before the first track's downbeat (its count-in is silence),
   * and from the top when the playhead is at the end.
   */
  function takeStart(): number {
    const first = tracks[0] ? takeOf(tracks[0]) : null;
    const downbeat = first?.countInMs != null ? Math.max(0, (first.offsetMs + first.countInMs) / 1000) : 0;
    let from = Math.max(currentTime, downbeat);
    if (from >= duration - 0.25) from = Math.min(downbeat, Math.max(0, duration - 0.25));
    return from;
  }

  /** Record a new take for `trackId`, or a new track (null), with the other tracks playing. */
  async function recordTake(trackId: string | null) {
    if (!canRecordTake) return;
    const track = trackId ? tracks.find((t) => t.id === trackId) : undefined;
    const label = track ? trackLabel(track) : nextTrackLabel;
    unlockMedia();
    mixer.pause();
    const from = takeStart();
    recordingInto = trackId;
    void app.startRecording({
      take: {
        sketchId: id,
        trackId,
        label,
        onDownbeat: () => {
          mixer.seek(from);
          void mixer.play();
          return from;
        },
        onEnd: () => {
          mixer.pause();
          recordingInto = undefined;
          armedTrack = null;
        },
      },
    });
    // Edits waiting to be saved go now (the panels stay mounted while recording).
    for (const panel of Object.values(panels)) void panel?.saveNow();
  }

  async function deleteTrack(track: Track) {
    if (armedTrack === track.id) armedTrack = null;
    try {
      await app.deleteTrack(id, track.id);
    } catch (error) {
      app.toast(`Could not delete the track: ${errorMessage(error)}`, 'error');
    }
  }

  async function deleteTake(takeId: string) {
    try {
      await app.deleteTake(id, takeId);
    } catch (error) {
      app.toast(`Could not delete the take: ${errorMessage(error)}`, 'error');
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

  function deleteSketch() {
    showMenu = false;
    confirmation = {
      title: 'Delete this sketch?',
      message:
        tracks.length > 1
          ? `All ${tracks.length} tracks, their recordings, transcriptions and your notes will be permanently removed from this device.`
          : 'The recording, its transcription and your notes will be permanently removed from this device.',
      action: 'Delete',
      danger: true,
      run: () => app.deleteSketch(id),
    };
  }

  async function exportSketch() {
    // Make sure the latest edits are in the MIDI / notes audio.
    await Promise.all(Object.values(panels).map((p) => p?.saveNow()));
    app.shareSketches([id]);
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea')) return;
    if (e.key === ' ' && !e.repeat) {
      e.preventDefault();
      togglePlay();
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
      <!-- 1. Tracks: each a piano roll with its waveform -->
      <section class="tracks" aria-label="Tracks">
        {#each tracks as track (track.id + ':' + track.takeId)}
          {@const take = takeOf(track)}
          {#if take}
            <TrackPanel
              bind:this={panels[track.id]}
              {track}
              {take}
              sketchTitle={title}
              {duration}
              {currentTime}
              {playing}
              {cropStart}
              {cropEnd}
              {view}
              multi={tracks.length > 1}
              audible={audible(track)}
              armed={armedTrack === track.id}
              canRecord={canRecordTake}
              deletable={!track.takes.some((t) => t.parentId === null)}
              {synth}
              onseek={seek}
              oncropchange={onCropChange}
              onupdate={(patch) => updateTrack(track, patch)}
              onarm={() => toggleArm(track)}
              ondelete={() => deleteTrack(track)}
              ondeletetake={deleteTake}
              onnotes={(notes) => (takeNotes = { ...takeNotes, [take.id]: notes })}
            />
          {/if}
        {/each}
        <button class="add-track" onclick={() => recordTake(null)} disabled={!canRecordTake}>
          <Icon name="plus" size={18} /> Add track
        </button>
      </section>

      <!-- 2. The take (video, or the audio-only badge) -->
      <section class="take" aria-label="Recording">
        <div class="media" class:audio-only={!shown?.take.hasVideo || !!sources[shown?.take.id ?? '']?.notice}>
          {#if shown && sources[shown.take.id]}
            {@const source = sources[shown.take.id]}
            {@const takeId = shown.take.id}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={mediaEls[takeId]}
              src={source.src}
              playsinline
              preload="auto"
              onloadedmetadata={(e) => onMetadata(takeId, e.currentTarget)}
              ondurationchange={(e) => onDurationChange(takeId, e.currentTarget)}
              onerror={(e) => source.failed((e.currentTarget as HTMLMediaElement).error, true)}
              onclick={togglePlay}
            ></video>
          {/if}
          {#if !shown?.take.hasVideo || sources[shown?.take.id ?? '']?.notice}
            <div class="audio-badge"><Icon name="mic" size={16} /> Audio-only {tracks.length > 1 ? 'tracks' : 'take'}</div>
          {/if}
        </div>
        {#if shown && tracks.length > 1 && shown.take.hasVideo}
          <p class="notice small">Video of {trackLabel(shown.track)}.</p>
        {/if}
        {#if shown && sources[shown.take.id]?.notice}<p class="notice small">{sources[shown.take.id].notice}</p>{/if}
        <!-- The other tracks play through hidden audio elements. -->
        <div class="hidden-media" aria-hidden="true">
          {#each playable.filter((e) => e !== shown) as entry (entry.take.id)}
            {@const takeId = entry.take.id}
            {#if sources[takeId]}
              {@const source = sources[takeId]}
              <audio
                bind:this={mediaEls[takeId]}
                src={source.src}
                preload="auto"
                onloadedmetadata={(e) => onMetadata(takeId, e.currentTarget)}
                ondurationchange={(e) => onDurationChange(takeId, e.currentTarget)}
                onerror={(e) => source.failed((e.currentTarget as HTMLMediaElement).error, false)}
              ></audio>
            {/if}
          {/each}
        </div>
      </section>

      <!-- 3. Notes and details -->
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
          <div><dt>Length</dt><dd class="tabular">{formatDuration(tracks.length > 1 ? duration * 1000 : (detail.durationMs ?? duration * 1000))}</dd></div>
          {#if tracks.length > 1}<div><dt>Tracks</dt><dd class="tabular">{tracks.length}</dd></div>{/if}
          <div><dt>Notes</dt><dd class="tabular">{noteCount}{anyEdits ? ' (edited)' : ''}</dd></div>
          {#if detail.recovered}<div><dt>Status</dt><dd>Recovered after an interruption</dd></div>{/if}
        </dl>
      </section>
    </div>

    <!-- The transport stays at the bottom of the screen; the sketch scrolls under it. -->
    <div class="transport-bar">
      <div class="transport-inner">
        {#if cropped}
          <div class="crop-info">
            <span class="tabular">Playing {formatClock(cropStart ?? 0)}–{formatClock(cropEnd ?? duration)}</span>
            <button class="link" onclick={clearCrop}>Play the whole {tracks.length > 1 ? 'sketch' : 'take'}</button>
          </div>
        {/if}
        <div class="transport">
          <button class="play" onclick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={22} />
          </button>
          {#if armed}
            <button
              class="record"
              onclick={() => recordTake(armed.id)}
              disabled={!canRecordTake}
              aria-label="Record a new take for {trackLabel(armed)}"
              title="Record a new take for {trackLabel(armed)}"
            >
              <span class="dot"></span>
            </button>
          {/if}
          <span class="time tabular"
            >{formatClock(currentTime)}<span class="dim"> / {formatClock(duration)}</span
            >{#if buffering}<span class="buffering" aria-live="polite"> loading…</span>{/if}</span
          >
          <span class="spacer"></span>
          <div class="segmented" role="group" aria-label="Listen to">
            <button aria-pressed={listen === 'recording'} onclick={() => setListen('recording')}>Take</button>
            <button aria-pressed={listen === 'notes'} onclick={() => setListen('notes')} disabled={noteCount === 0}
              >Notes</button
            >
            <button aria-pressed={listen === 'both'} onclick={() => setListen('both')} disabled={noteCount === 0}
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
  .sketch-view {
    min-height: 100vh;
    min-height: 100dvh;
    width: 100%;
    /* Height of the fixed transport, so the end of the page can scroll clear of it. */
    --transport-h: 64px;
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
     scrolls inside itself instead of widening the page. */
  .content {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
    width: 100%;
    max-width: 1100px;
    margin: 0 auto;
    padding: 10px calc(var(--safe-right) + 12px) calc(var(--safe-bottom) + var(--transport-h) + 56px)
      calc(var(--safe-left) + 12px);
  }
  .content > section {
    min-width: 0;
  }
  .tracks {
    display: grid;
    gap: 14px;
  }
  .add-track {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 46px;
    border-radius: var(--radius-sm);
    border: 1.5px dashed var(--rule-strong);
    color: var(--ink-2);
    font-weight: 600;
  }
  .add-track:hover:not(:disabled) {
    background: var(--paper-sunk);
  }
  .add-track:disabled {
    opacity: 0.5;
  }

  /* The transport, fixed to the bottom. */
  .transport-bar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 15;
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-top: 1px solid var(--rule);
    padding: 8px calc(var(--safe-right) + 12px) calc(var(--safe-bottom) + 8px) calc(var(--safe-left) + 12px);
  }
  .transport-inner {
    max-width: 1100px;
    margin: 0 auto;
    display: grid;
    gap: 6px;
  }
  .transport {
    display: flex;
    align-items: center;
    gap: 6px;
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
  .record {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    border: 2px solid var(--ink);
    background: var(--paper-raised);
  }
  .record .dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent);
  }
  .record:disabled {
    opacity: 0.5;
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
    .transport {
      gap: 4px;
    }
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
  .hidden-media {
    display: none;
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

  @media (max-width: 430px) {
    .time .dim {
      display: none;
    }
  }

  /* Wide screens: the take and the notes side by side under the tracks. */
  @media (min-width: 900px) {
    .content {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        'tracks tracks'
        'take about';
      align-items: start;
    }
    .tracks {
      grid-area: tracks;
    }
    .take {
      grid-area: take;
    }
    .about {
      grid-area: about;
    }
  }

  /* Phones in landscape: the video may use more of the height. */
  @media (orientation: landscape) and (max-height: 540px) {
    .media video {
      max-height: 70vh;
    }
  }
</style>
