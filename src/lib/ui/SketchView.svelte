<script lang="ts">
  /**
   * An open sketch: its tracks (each a piano roll, its chords and its
   * waveform; collapsed, the waveform), Record / Import track, the Chords
   * section (the key, the chords used and how to play them, the circle of
   * fifths), the video, text notes and details. The top bar
   * (title, timecode, tempo) and the transport (play, what plays, loop)
   * stay on screen. All tracks play together on one timeline through one
   * Web Audio graph (`AudioEngine`), honouring mute and solo; each can play
   * its recording, its notes or both ("Separate"). The video only shows the
   * picture (muted), following the sound.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { ClickTrack } from '../capture/countIn';
  import type { Sketch, SketchDetail, TempoSource, Track, UpdateTrackArgs } from '../library/types';
  import { detectChords, type ChordSegment } from '../music/chords';
  import { detectKey, spellChord } from '../music/key';
  import { notesEndTime } from '../music/notes';
  import { NoteSynth } from '../music/synth';
  import { confidentTempo, nearestBeat, nextBeat } from '../music/tempo';
  import { AudioEngine, type EngineTrack } from '../playback/audioEngine';
  import { loadTakeBuffer, stretchBuffer } from '../playback/takeBuffers';
  import { TakeSource } from '../playback/takeSource.svelte';
  import { VideoFollower } from '../playback/videoFollower';
  import { errorMessage } from '../platform/tauri';
  import { app } from '../state/app.svelte';
  import type { PianoNote } from '../transcription/types';
  import ChordsPanel from './ChordsPanel.svelte';
  import Icon from './Icon.svelte';
  import ImportSheet from './ImportSheet.svelte';
  import { RollViewport } from './rollViewport.svelte';
  import Sheet from './Sheet.svelte';
  import TempoSheet from './TempoSheet.svelte';
  import TrackPanel, { type ListenMode } from './TrackPanel.svelte';
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
  /** The take shown as video: the first one with video. */
  const shown = $derived(playable.find((e) => e.take.hasVideo) ?? null);

  // --------------------------------------------------------- playback
  /** Each take's decoded sound, by take id. */
  let buffers = $state.raw<Record<string, AudioBuffer>>({});
  /** Takes being decoded, and those that could not be (with the analysis audio they were tried with). */
  let decoding = $state.raw<Record<string, { state: 'loading' | 'failed'; analysis: string | null }>>({});
  let videoEl = $state<HTMLVideoElement | null>(null);
  let videoSource = $state<TakeSource | null>(null);
  let currentTime = $state(0);
  let playing = $state(false);
  let rate = $state(1);
  /** What plays: every track's recording, notes or both, or each track its own ("separate"). */
  let listen = $state<ListenMode | 'separate'>('recording');
  /** Each track's choice when `listen` is "separate". */
  let trackListen = $state<Record<string, ListenMode>>({});
  let buffering = $state(false);
  /** Playback crop range in seconds (null = whole sketch). */
  let cropStart = $state<number | null>(null);
  let cropEnd = $state<number | null>(null);
  let loopPlayback = $state(false);
  /** The track armed to record a new take (the R toggle). */
  let armedTrack = $state<string | null>(null);
  /** Recording into this sketch: the track getting a new take, null for a new track, undefined when not. */
  let recordingInto = $state<string | null | undefined>(undefined);
  const view = new RollViewport();
  let disposed = false;

  /** What a track plays. */
  const modeOf = (track: Track): ListenMode => (listen === 'separate' ? (trackListen[track.id] ?? 'recording') : listen);
  /** Its recording is heard. */
  const takeHeard = (track: Track) => audible(track) && track.id !== recordingInto && modeOf(track) !== 'notes';
  /** Its notes are played by the synth. */
  const notesHeard = (track: Track) => audible(track) && track.id !== recordingInto && modeOf(track) !== 'recording';

  // ------------------------------------------------------------ tempo
  let tempo = $state<{ bpm: number | null; beat: number | null; source: TempoSource | null }>({
    bpm: null,
    beat: null,
    source: null,
  });
  let showTempo = $state(false);
  let tempoTimer: number | undefined;
  /** A click on the beat while the tempo sheet is open, to set the tempo by ear. */
  const click = new ClickTrack();
  $effect(() => {
    click.setGrid(tempo.bpm, tempo.beat);
  });

  /**
   * Every sound of the sketch: the tracks' recordings and the synth, on one
   * audio clock. The waveforms, piano rolls, video and click follow it.
   */
  const engine = new AudioEngine({
    onState: (state) => {
      currentTime = state.position;
      buffering = state.buffering;
      if (state.playing !== playing) {
        playing = state.playing;
        if (!playing) click.stop();
        else if (showTempo) click.start();
      }
      video.update(state.position, state.playing && !state.buffering, rate);
    },
    onFrame: (position, playbackRate) => {
      synth.pump();
      if (showTempo) click.tick(position, playbackRate);
      video.update(position, true, playbackRate);
    },
    onCue: (clock) => {
      if (clock && synthOn) synth.cue(clock);
      else synth.stop();
    },
    stretch: stretchBuffer,
    log: (message) => app.logCapture(`[playback] ${message}`),
  });
  const synth = new NoteSynth({ context: () => engine.context, destination: () => engine.input });
  const video = new VideoFollower({
    // WebKit can play a file URL it cannot seek in; an in-memory copy can.
    onUnseekable: () => {
      void videoSource?.loadIntoMemory().then((switched) =>
        app.logCapture(`[playback] ${switched ? 'showing an in-memory copy of the video so seeking works' : 'the video cannot seek'}`),
      );
    },
  });

  // Each take's sound is decoded as it appears (and again once its analysis audio exists, if it failed before).
  $effect(() => {
    const wanted = playable.map((e) => e.take);
    untrack(() => {
      const capture = app.exportDeps().capture;
      for (const take of wanted) {
        const analysis = take.analysisPath;
        const tried = decoding[take.id];
        if (buffers[take.id] || tried?.state === 'loading' || (tried && tried.analysis === analysis)) continue;
        const takeId = take.id;
        decoding = { ...decoding, [takeId]: { state: 'loading', analysis } };
        loadTakeBuffer(
          engine.context,
          { mediaPath: take.mediaPath, analysisPath: analysis, hasVideo: take.hasVideo },
          {
            exportAudio: capture?.exportAudio ? (media, out) => capture.exportAudio!(media, out) : undefined,
            log: (message) => app.logCapture(`[playback] ${message}`),
          },
        ).then(
          (buffer) => {
            if (disposed) return;
            buffers = { ...buffers, [takeId]: buffer };
            const { [takeId]: _done, ...rest } = decoding;
            decoding = rest;
          },
          (error) => {
            if (disposed) return;
            app.logCapture(`[playback] could not decode take ${takeId}: ${errorMessage(error)}`);
            decoding = { ...decoding, [takeId]: { state: 'failed', analysis } };
          },
        );
      }
      // Let go of the sound of takes no longer played.
      const keep = new Set(wanted.map((t) => t.id));
      if (Object.keys(buffers).some((k) => !keep.has(k))) {
        buffers = Object.fromEntries(Object.entries(buffers).filter(([k]) => keep.has(k)));
      }
    });
  });

  // The video's source follows the take shown.
  $effect(() => {
    const take = shown?.take ?? null;
    untrack(() => {
      videoSource?.dispose();
      videoSource = take ? new TakeSource(take.mediaPath, (message) => app.logCapture(`[playback] ${message}`)) : null;
    });
  });
  $effect(() => {
    const el = videoEl;
    const offset = (shown?.take.offsetMs ?? 0) / 1000;
    untrack(() => {
      video.attach(el, offset);
      video.update(currentTime, playing && !buffering, rate);
    });
  });

  const engineTracks = $derived<EngineTrack[]>(
    playable.map(({ track, take }) => ({
      id: track.id,
      buffer: buffers[take.id] ?? null,
      loading: !buffers[take.id] && decoding[take.id]?.state !== 'failed',
      offset: take.offsetMs / 1000,
      audible: takeHeard(track),
    })),
  );
  $effect(() => {
    const list = engineTracks;
    untrack(() => engine.setTracks(list));
  });

  /** Length of the sketch: the end of its latest take (or of its notes). */
  const duration = $derived.by(() => {
    let end = 0;
    for (const track of tracks) {
      const take = takeOf(track);
      if (!take) continue;
      const offset = take.offsetMs / 1000;
      const length = buffers[take.id]?.duration || (take.durationMs ?? 0) / 1000;
      end = Math.max(end, offset + length, offset + notesEndTime(takeNotes[take.id] ?? []));
    }
    return end;
  });
  $effect(() => {
    engine.setDuration(duration);
  });

  /** The notes the synth plays: those of the tracks whose notes are heard, on the sketch's timeline. */
  const synthOn = $derived(playable.some((e) => notesHeard(e.track)));
  const mixedNotes = $derived(
    playable.flatMap(({ track, take }) => {
      if (!notesHeard(track)) return [];
      const notes = takeNotes[take.id] ?? [];
      const offset = take.offsetMs / 1000;
      if (offset === 0) return notes;
      return notes
        .filter((n) => n.endTime + offset > 0)
        .map((n) => ({ ...n, startTime: Math.max(0, n.startTime + offset), endTime: n.endTime + offset }));
    }),
  );
  const noteCount = $derived(playable.reduce((sum, e) => sum + (takeNotes[e.take.id]?.length ?? 0), 0));

  // ---------------------------------------------------------- analysis
  /** The notes of the tracks being heard (mute and solo apply), together on the sketch's timeline. */
  const heardNotes = $derived(
    playable.flatMap(({ track, take }) => {
      if (!audible(track)) return [];
      const offset = take.offsetMs / 1000;
      const notes = takeNotes[take.id] ?? [];
      return offset === 0 ? notes : notes.map((n) => ({ ...n, startTime: n.startTime + offset, endTime: n.endTime + offset }));
    }),
  );
  const sketchChords = $derived(detectChords(heardNotes));
  const sketchKey = $derived(detectKey(heardNotes));
  /** Chord symbols spelled for the sketch's key, everywhere they are shown. */
  const spell = $derived((chord: ChordSegment) => spellChord(chord, sketchKey));
  const analysisState = $derived.by(() => {
    if (heardNotes.length > 0) return 'ready' as const;
    const waiting = playable.some(({ take }) => {
      const live = app.sketches.find((s) => s.id === take.id) ?? take;
      return !!app.jobs[take.id] || live.transcriptionStatus === 'pending' || live.transcriptionStatus === 'running';
    });
    return waiting ? ('pending' as const) : ('empty' as const);
  });

  function playPitches(pitches: number[], spread: number) {
    synth.playChord(pitches, 80, 1.6, spread);
  }
  const anyEdits = $derived(playable.some((e) => e.take.hasEdits));

  $effect(() => {
    synth.setNotes(mixedNotes);
  });
  $effect(() => {
    // While recording into the sketch the other tracks play to the end: no crop, no loop.
    const overdub = recordingInto !== undefined;
    engine.setRange(overdub ? 0 : (cropStart ?? 0), overdub ? null : cropEnd);
  });
  $effect(() => {
    engine.setLoop(loopPlayback && recordingInto === undefined);
  });
  $effect(() => {
    // Notes switched on or off while playing.
    const on = synthOn;
    untrack(() => {
      if (!on) synth.stop();
      else if (engine.clock) synth.cue(engine.clock);
    });
  });
  $effect(() => {
    // "Separate" needs several tracks; with one, keep what it played.
    if (listen === 'separate' && tracks.length < 2) listen = (tracks[0] && trackListen[tracks[0].id]) || 'recording';
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
      tempo = {
        bpm: d.tempoBpm,
        beat: d.beatMs !== null ? d.beatMs / 1000 : null,
        source: d.tempoSource,
      };
      cropStart = d.cropStartMs !== null ? d.cropStartMs / 1000 : null;
      cropEnd = d.cropEndMs !== null ? d.cropEndMs / 1000 : null;
    } catch (error) {
      loadError = errorMessage(error);
    }
  }

  /** Pick up new tracks and takes (the panels reload their own notes). */
  async function refresh() {
    try {
      const d = await app.library.get(id);
      detail = d;
      // A tempo found after transcribing arrives here; one being edited stays.
      if (tempoTimer === undefined) {
        tempo = { bpm: d.tempoBpm, beat: d.beatMs !== null ? d.beatMs / 1000 : null, source: d.tempoSource };
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
    disposed = true;
    window.clearTimeout(notesTimer);
    if (detail && textNotes !== detail.textNotes) void app.saveNotesText(id, textNotes);
    if (tempoTimer !== undefined) void saveTempo();
    synth.dispose();
    engine.dispose();
    click.dispose();
    // Release the video pipeline right away instead of waiting for garbage collection.
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    }
    videoSource?.dispose();
  });

  // ------------------------------------------------------------ media

  function onVideoMetadata(el: HTMLVideoElement) {
    if (el.duration === Infinity) {
      // MediaRecorder WebM files have no duration (and seek badly) until scanned once.
      const reset = () => {
        el.removeEventListener('durationchange', reset);
        el.currentTime = 0;
        video.update(currentTime, playing && !buffering, rate);
      };
      el.addEventListener('durationchange', reset);
      el.currentTime = 1e101;
      return;
    }
    video.update(currentTime, playing && !buffering, rate);
  }

  function togglePlay() {
    // Wake the audio inside this tap (WebKit starts audio only in a gesture).
    if (!playing) engine.unlock();
    engine.toggle();
  }

  function seek(t: number) {
    engine.seek(t);
  }

  function setRate(next: number) {
    rate = next;
    engine.setRate(rate);
  }

  function setListen(mode: typeof listen) {
    if (mode === 'separate' && listen !== 'separate') {
      // Each track starts from what everything played.
      const from = listen;
      trackListen = Object.fromEntries(tracks.map((t) => [t.id, from]));
    }
    listen = mode;
    if (mode !== 'recording') synth.unlock();
  }

  function setTrackListen(track: Track, mode: ListenMode) {
    trackListen = { ...trackListen, [track.id]: mode };
    if (mode !== 'recording') synth.unlock();
  }

  // ------------------------------------------------------------ tempo

  /** The first track's notes (its take's own time) and where they sit on the timeline. */
  function firstTrackNotes(): { notes: PianoNote[]; offset: number } | null {
    const first = tracks[0] ? takeOf(tracks[0]) : null;
    const notes = first ? takeNotes[first.id] : undefined;
    return first && notes?.length ? { notes, offset: first.offsetMs / 1000 } : null;
  }

  function setTempo(bpm: number | null, beat: number | null, source: TempoSource | null) {
    tempo = { bpm, beat, source };
    window.clearTimeout(tempoTimer);
    tempoTimer = window.setTimeout(() => void saveTempo(), 500);
  }

  async function saveTempo() {
    window.clearTimeout(tempoTimer);
    tempoTimer = undefined;
    try {
      const { bpm, beat, source } = tempo;
      app.upsert(await app.library.setTempo(id, bpm, bpm !== null && beat !== null ? Math.round(beat * 1000) : null, source));
    } catch (error) {
      app.toast(`Could not save the tempo: ${errorMessage(error)}`, 'error');
    }
  }

  /**
   * A tempo chosen by hand. The beat nearest the playhead stays where it is
   * (so the click stays on the music being listened to); a tapped tempo puts
   * a beat at the playhead (the last tap).
   */
  function setTempoByHand(bpm: number, tapped = false) {
    let beat: number;
    if (tapped && playing) beat = currentTime;
    else if (tempo.bpm !== null && tempo.beat !== null) beat = nearestBeat(currentTime, tempo.bpm, tempo.beat);
    else beat = currentTime;
    setTempo(bpm, beat, 'user');
  }

  /** Detect the tempo from the first track's notes; false if there is no steady one. */
  function detectTempo(source: TempoSource = 'detected'): boolean {
    const first = firstTrackNotes();
    const found = first ? confidentTempo(first.notes) : null;
    if (!found || !first) return false;
    setTempo(found.bpm, found.beat + first.offset, source);
    return true;
  }

  // Older sketches have no tempo yet: try once their first track's notes are in.
  let triedDetecting = false;
  $effect(() => {
    if (triedDetecting || !detail || tempo.bpm !== null || !firstTrackNotes()) return;
    triedDetecting = true;
    untrack(() => detectTempo());
  });

  function openTempo() {
    showTempo = true;
    if (playing) click.start();
  }

  function closeTempo() {
    showTempo = false;
    click.stop();
    if (tempoTimer !== undefined) void saveTempo();
  }

  /** Play from the tempo sheet: the click starts in this tap (iOS starts audio only in a gesture). */
  function togglePlayWithClick() {
    if (!playing) click.start();
    togglePlay();
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

  /** Where the sketch's playing starts: after the first track's count-in, if it had one (seconds). */
  function firstDownbeat(): number {
    const first = tracks[0] ? takeOf(tracks[0]) : null;
    return first?.countInMs != null ? Math.max(0, (first.offsetMs + first.countInMs) / 1000) : 0;
  }

  let showImport = $state(false);
  const canImport = $derived(!app.recording && !!detail && detail.status === 'saved');

  async function importTrack(kind: 'midi' | 'audio', file: File, offsetMs: number): Promise<boolean> {
    engine.pause();
    return app.importTrack(id, kind, file, offsetMs);
  }

  /**
   * Where the other tracks start while a take is recorded: the playhead,
   * but not before the first track's downbeat (its count-in is silence),
   * from the top when the playhead is at the end, and on a beat when the
   * sketch has a tempo (so the count-in leads into it).
   */
  function takeStart(): number {
    const downbeat = firstDownbeat();
    let from = Math.max(currentTime, downbeat);
    if (from >= duration - 0.25) from = Math.min(downbeat, Math.max(0, duration - 0.25));
    if (tempo.bpm !== null && tempo.beat !== null) {
      const onBeat = nextBeat(from - 0.02, tempo.bpm, tempo.beat);
      if (onBeat < duration) from = onBeat;
    }
    return Math.max(0, from);
  }

  /** Record a new take for `trackId`, or a new track (null), with the other tracks playing. */
  async function recordTake(trackId: string | null) {
    if (!canRecordTake) return;
    const track = trackId ? tracks.find((t) => t.id === trackId) : undefined;
    const label = track ? trackLabel(track) : nextTrackLabel;
    engine.unlock();
    engine.pause();
    const from = takeStart();
    recordingInto = trackId;
    // The take is recorded in real time: the others play at full speed meanwhile.
    if (rate !== 1) engine.setRate(1);
    void app.startRecording({
      take: {
        sketchId: id,
        trackId,
        label,
        tempo: tempo.bpm !== null ? { bpm: tempo.bpm, beat: tempo.beat ?? from } : undefined,
        onDownbeat: () => {
          engine.seek(from);
          engine.play();
          // What is heard at this instant: the start sounds after the engine's lead and the output
          // latency, so the downbeat meets a point just before `from`.
          const heard = engine.heardPosition();
          if (!engine.clock) app.logCapture('[playback] the other tracks could not start at the downbeat; the take may need lining up');
          return heard;
        },
        onEnd: () => {
          engine.pause();
          engine.setRate(rate);
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
    <div class="bar-row">
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
    </div>
    {#if detail}
      <!-- Timecode and tempo stay on screen with the title. -->
      <div class="bar-row status">
        <span class="time tabular"
          >{formatClock(currentTime)}<span class="dim"> / {formatClock(duration)}</span
          >{#if buffering}<span class="buffering" aria-live="polite"> loading…</span>{/if}{#if rate !== 1}<span
              class="rate-note"
            >
              · {rate}×</span
            >{/if}</span
        >
        <span class="spacer"></span>
        <button class="tempo-button tabular" onclick={openTempo} aria-label="Tempo{tempo.bpm !== null ? ` ${Math.round(tempo.bpm)} BPM` : ''}">
          <span class="note" aria-hidden="true">♩</span>
          {#if tempo.bpm !== null}{Math.round(tempo.bpm)}<span class="unit">BPM</span>{:else}<span class="unit">Set tempo</span>{/if}
        </button>
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
              listenMode={listen === 'separate' ? modeOf(track) : null}
              onlisten={(mode) => setTrackListen(track, mode)}
              {spell}
            />
          {/if}
        {/each}
        <div class="add-track">
          <button onclick={() => recordTake(null)} disabled={!canRecordTake}>
            <span class="rec-dot" aria-hidden="true"></span> Record track
          </button>
          <button onclick={() => (showImport = true)} disabled={!canImport}>
            <Icon name="import" size={18} /> Import track
          </button>
        </div>
      </section>

      <!-- 2. The harmony of what is heard -->
      <div class="analysis-area">
      <ChordsPanel
        chords={sketchChords}
        key={sketchKey}
        {currentTime}
        status={analysisState}
        combined={playable.filter((e) => audible(e.track)).length > 1}
        onplay={playPitches}
        onseek={seek}
      />
      </div>

      <!-- 3. The take's video (its sound plays with the tracks), or the audio-only badge -->
      <section class="take" aria-label="Recording">
        <div class="media" class:audio-only={!shown || !!videoSource?.notice}>
          {#if shown && videoSource && !videoSource.notice}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video
              bind:this={videoEl}
              src={videoSource.src}
              playsinline
              muted
              preload="auto"
              onloadedmetadata={(e) => onVideoMetadata(e.currentTarget)}
              onerror={(e) => videoSource?.failed((e.currentTarget as HTMLMediaElement).error)}
              onclick={togglePlay}
            ></video>
          {:else}
            <div class="audio-badge"><Icon name="mic" size={16} /> Audio-only {tracks.length > 1 ? 'tracks' : 'take'}</div>
          {/if}
        </div>
        {#if shown && tracks.length > 1 && !videoSource?.notice}
          <p class="notice small">Video of {trackLabel(shown.track)}.</p>
        {/if}
        {#if videoSource?.notice}<p class="notice small">{videoSource.notice}</p>{/if}
        {#each playable.filter((e) => decoding[e.take.id]?.state === 'failed') as entry (entry.take.id)}
          <p class="notice small">{trackLabel(entry.track)} cannot be played on this device yet. Its recording is saved.</p>
        {/each}
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
          <span class="spacer"></span>
          <div class="segmented listen" role="group" aria-label="Listen to">
            <button aria-pressed={listen === 'recording'} onclick={() => setListen('recording')}>Take</button>
            <button aria-pressed={listen === 'notes'} onclick={() => setListen('notes')} disabled={noteCount === 0}
              >Notes</button
            >
            <button aria-pressed={listen === 'both'} onclick={() => setListen('both')} disabled={noteCount === 0}
              >Both</button
            >
            {#if tracks.length > 1}
              <button aria-pressed={listen === 'separate'} onclick={() => setListen('separate')} title="Choose for each track"
                >Separate</button
              >
            {/if}
          </div>
          <span class="spacer"></span>
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
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showImport}
  <ImportSheet
    start={firstDownbeat()}
    playhead={currentTime}
    onimport={importTrack}
    onclose={() => (showImport = false)}
  />
{/if}

{#if showTempo}
  <TempoSheet
    bpm={tempo.bpm}
    source={tempo.source}
    {playing}
    {rate}
    canDetect={!!firstTrackNotes()}
    onchange={setTempoByHand}
    onclear={() => setTempo(null, null, null)}
    ondetect={() => detectTempo()}
    ontoggleplay={togglePlayWithClick}
    onrate={setRate}
    onclose={closeTempo}
  />
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
    display: grid;
    padding: calc(var(--safe-top) + 6px) calc(var(--safe-right) + 6px) 4px calc(var(--safe-left) + 6px);
    background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }
  .bar-row.status {
    gap: 8px;
    padding: 0 6px 2px 12px;
  }
  .tempo-button {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    min-height: 32px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--rule-strong);
    font-weight: 700;
    font-size: 0.95rem;
  }
  .tempo-button .note {
    font-weight: 400;
    color: var(--ink-3);
  }
  .tempo-button .unit {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--ink-3);
    letter-spacing: 0.04em;
  }
  .rate-note {
    color: var(--accent);
    font-size: 0.85rem;
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
  .content > section,
  .analysis-area {
    min-width: 0;
  }
  .tracks {
    display: grid;
    gap: 14px;
  }
  /* Record and Import share the row under the tracks. */
  .add-track {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .add-track button {
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
  .add-track button:hover:not(:disabled) {
    background: var(--paper-sunk);
  }
  .add-track button:disabled {
    opacity: 0.5;
  }
  .add-track .rec-dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
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
    font-size: 1.05rem;
    font-weight: 600;
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
      padding: 0 8px;
      font-size: 0.8rem;
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

  /* Wide screens: the take and the notes side by side under the tracks. */
  @media (min-width: 900px) {
    .content {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      grid-template-areas:
        'tracks tracks'
        'analysis analysis'
        'take about';
      align-items: start;
    }
    .tracks {
      grid-area: tracks;
    }
    .analysis-area {
      grid-area: analysis;
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
