/**
 * In-memory Sketch Library used when the UI runs in a plain browser
 * (`npm run dev` without Tauri) and in end-to-end tests. Mirrors the
 * semantics of the Rust implementation: recordings are immutable once saved
 * and edits never overwrite the original transcription. Files are kept as
 * Blobs and exposed through blob: URLs. Nothing survives a reload.
 */
import type { SketchSummary } from '../music/summary';
import type { PianoNote } from '../transcription/types';
import type {
  CreateRhythmArgs,
  CreateSketchArgs,
  CreateTextNoteArgs,
  CreatedSketch,
  DuplicateSketchArgs,
  ExportBundle,
  ExportKind,
  FileKind,
  FinalizeSketchArgs,
  Notebook,
  PlaceSketchArgs,
  RecoveryReport,
  Sample,
  CreateSampleArgs,
  UpdateSampleArgs,
  SaveEditsArgs,
  SaveTranscriptionArgs,
  Sketch,
  SketchDetail,
  SketchLibrary,
  TempoSource,
  Track,
  Transcription,
  TranscriptionStatus,
  UpdateRhythmArgs,
  UpdateTextNoteArgs,
  UpdateSketchArgs,
  UpdateTrackArgs,
} from './types';
import { MAX_CANVAS_REPEATS } from './types';

interface Entry {
  sketch: Sketch;
  transcription: Transcription | null;
  chunks: BlobPart[];
  files: Map<string, { blob: Blob; url: string }>;
}

type TrackRow = Omit<Track, 'takes'>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newId = () => crypto.randomUUID().replace(/-/g, '');

export class MemoryLibrary implements SketchLibrary {
  readonly persistent = false;
  private entries = new Map<string, Entry>();
  private tracks = new Map<string, TrackRow>();
  private notebooks = new Map<string, Notebook>();
  private samples = new Map<string, { sample: Sample; url: string }>();

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`sketch not found: ${id}`);
    return entry;
  }

  private snapshot(entry: Entry): Sketch {
    return { ...clone(entry.sketch), summary: entry.sketch.summary ? clone(entry.sketch.summary) : null };
  }

  async recover(): Promise<RecoveryReport> {
    return { recovered: [], discarded: [], requeued: [] };
  }

  async list(): Promise<Sketch[]> {
    return [...this.entries.values()]
      .map((e) => this.snapshot(e))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<SketchDetail> {
    const entry = this.entry(id);
    return {
      ...this.snapshot(entry),
      transcription: entry.transcription ? clone(entry.transcription) : null,
      tracks: entry.sketch.parentId === null ? this.tracksOf(id) : [],
    };
  }

  private tracksOf(sketchId: string): Track[] {
    return [...this.tracks.values()]
      .filter((t) => t.sketchId === sketchId)
      .sort((a, b) => a.position - b.position || a.createdAt - b.createdAt)
      .map((t) => ({
        ...t,
        takes: [...this.entries.values()]
          .filter((e) => e.sketch.trackId === t.id)
          .map((e) => this.snapshot(e))
          .sort((a, b) => a.createdAt - b.createdAt),
      }));
  }

  async create(args: CreateSketchArgs): Promise<CreatedSketch> {
    const id = newId();
    const now = Date.now();
    let trackId: string;
    let newTrack: TrackRow | null = null;
    if (args.parentId) {
      const parent = this.entry(args.parentId);
      if (parent.sketch.parentId !== null) throw new Error('takes belong to a sketch, not to another take');
      if (args.trackId) {
        if (this.tracks.get(args.trackId)?.sketchId !== args.parentId) throw new Error(`track not found: ${args.trackId}`);
        trackId = args.trackId;
      } else {
        const positions = [...this.tracks.values()].filter((t) => t.sketchId === args.parentId).map((t) => t.position);
        const position = positions.length ? Math.max(...positions) + 1 : 0;
        trackId = newId();
        newTrack = { id: trackId, sketchId: args.parentId, position, name: `Track ${position + 1}`, takeId: id, muted: false, solo: false, collapsed: false, createdAt: now };
      }
    } else {
      trackId = newId();
      newTrack = { id: trackId, sketchId: id, position: 0, name: 'Track 1', takeId: id, muted: false, solo: false, collapsed: false, createdAt: now };
    }
    const notebookId = args.parentId ? null : (args.notebookId ?? null);
    if (notebookId) this.notebook(notebookId);
    const dir = `memory://${id}`;
    const mediaPath = `${dir}/recording.${args.mediaExtension}`;
    this.entries.set(id, {
      sketch: {
        id,
        title: (args.title ?? '').trim(),
        createdAt: now,
        updatedAt: now,
        status: 'recording',
        durationMs: null,
        mediaPath,
        mediaMime: args.mediaMime,
        hasVideo: true,
        videoWidth: null,
        videoHeight: null,
        analysisPath: null,
        textNotes: '',
        transcriptionStatus: 'pending',
        transcriptionError: null,
        captureBackend: args.captureBackend,
        recovered: false,
        summary: null,
        hasEdits: false,
        listenMode: 'recording',
        cropStartMs: null,
        cropEndMs: null,
        parentId: args.parentId ?? null,
        trackId,
        offsetMs: 0,
        countInMs: null,
        tempoBpm: null,
        beatMs: null,
        tempoSource: null,
        notebookId,
        canvasXMs: Math.round(args.canvasXMs ?? 0),
        canvasY: validY(args.canvasY ?? 0),
        kind: 'audio',
        rhythm: null,
        canvasRepeats: 1,
        canvasVolume: 1,
        noteSampleId: null,
        canvasW: null,
        canvasH: null,
      },
      transcription: null,
      chunks: [],
      files: new Map(),
    });
    if (newTrack) this.tracks.set(trackId, newTrack);
    return { id, dir, mediaPath, analysisPath: `${dir}/analysis.wav`, createdAt: now, trackId };
  }

  async finalize(args: FinalizeSketchArgs): Promise<Sketch> {
    const entry = this.entry(args.id);
    const blob = new Blob(entry.chunks, { type: entry.sketch.mediaMime ?? '' });
    if (blob.size === 0) throw new Error(`recording for sketch ${args.id} is empty or missing`);
    const url = URL.createObjectURL(blob);
    entry.files.set('media', { blob, url });
    entry.chunks = [];
    Object.assign(entry.sketch, {
      status: 'saved',
      durationMs: args.durationMs ?? entry.sketch.durationMs,
      hasVideo: args.hasVideo,
      videoWidth: args.videoWidth,
      videoHeight: args.videoHeight,
      mediaPath: url,
      updatedAt: Date.now(),
      offsetMs: args.offsetMs ?? entry.sketch.offsetMs,
      countInMs: args.countInMs ?? entry.sketch.countInMs,
      canvasXMs: args.canvasXMs ?? entry.sketch.canvasXMs,
    } satisfies Partial<Sketch>);
    const track = entry.sketch.trackId ? this.tracks.get(entry.sketch.trackId) : undefined;
    if (track) track.takeId = args.id;
    return this.snapshot(entry);
  }

  async discard(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.sketch.status === 'saved') throw new Error('refusing to discard a saved sketch');
    await this.remove(id);
  }

  async updateTrack(args: UpdateTrackArgs): Promise<Track> {
    const track = this.tracks.get(args.id);
    if (!track) throw new Error(`track not found: ${args.id}`);
    if (args.takeId !== undefined) {
      const take = this.entries.get(args.takeId);
      if (take?.sketch.trackId !== args.id) throw new Error(`take not found: ${args.takeId}`);
      if (take.sketch.status !== 'saved') throw new Error('that take is still being recorded');
      track.takeId = args.takeId;
    }
    if (args.name !== undefined) track.name = args.name.trim().slice(0, 60);
    if (args.muted !== undefined) track.muted = args.muted;
    if (args.solo !== undefined) track.solo = args.solo;
    if (args.collapsed !== undefined) track.collapsed = args.collapsed;
    if (args.offsetMs !== undefined) this.entry(track.takeId).sketch.offsetMs = args.offsetMs;
    return this.tracksOf(track.sketchId).find((t) => t.id === args.id)!;
  }

  async removeTrack(id: string): Promise<void> {
    if (!this.tracks.has(id)) throw new Error(`track not found: ${id}`);
    const takes = [...this.entries.values()].filter((e) => e.sketch.trackId === id);
    if (takes.some((e) => e.sketch.parentId === null)) {
      throw new Error("this track holds the sketch's first recording; delete the sketch instead");
    }
    for (const e of takes) this.drop(e.sketch.id);
    this.tracks.delete(id);
  }

  async removeTake(id: string): Promise<void> {
    if (this.entry(id).sketch.parentId === null) {
      throw new Error("this is the sketch's first recording; delete the sketch instead");
    }
    this.removeTakeRow(id);
  }

  private drop(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const f of entry.files.values()) URL.revokeObjectURL(f.url);
    this.entries.delete(id);
  }

  /** Remove a take; its track plays its latest remaining take, or goes. */
  private removeTakeRow(id: string) {
    const trackId = this.entries.get(id)?.sketch.trackId;
    this.drop(id);
    const track = trackId ? this.tracks.get(trackId) : undefined;
    if (!track) return;
    const remaining = [...this.entries.values()]
      .filter((e) => e.sketch.trackId === track.id)
      .sort((a, b) => Number(b.sketch.status === 'saved') - Number(a.sketch.status === 'saved') || b.sketch.createdAt - a.sketch.createdAt);
    if (remaining.length === 0) this.tracks.delete(track.id);
    else if (!remaining.some((e) => e.sketch.id === track.takeId)) track.takeId = remaining[0].sketch.id;
  }

  async update(args: UpdateSketchArgs): Promise<Sketch> {
    const entry = this.entry(args.id);
    if (args.listenMode !== undefined) {
      if (!['recording', 'notes', 'both'].includes(args.listenMode)) throw new Error('unknown listen mode');
      entry.sketch.listenMode = args.listenMode;
    }
    if (args.title !== undefined) entry.sketch.title = args.title.trim();
    if (args.textNotes !== undefined) entry.sketch.textNotes = args.textNotes;
    if (args.durationMs !== undefined) entry.sketch.durationMs = args.durationMs;
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  async setCrop(id: string, startMs: number | null, endMs: number | null): Promise<Sketch> {
    const entry = this.entry(id);
    if (startMs !== null && endMs !== null && endMs - startMs < 100) throw new Error('crop range is too short');
    entry.sketch.cropStartMs = startMs;
    entry.sketch.cropEndMs = endMs;
    return this.snapshot(entry);
  }

  async setTempo(id: string, bpm: number | null, beatMs: number | null, source: TempoSource | null): Promise<Sketch> {
    const entry = this.entry(id);
    if (bpm !== null && !(bpm >= 20 && bpm <= 400)) throw new Error(`tempo ${bpm} is out of range`);
    entry.sketch.tempoBpm = bpm;
    entry.sketch.beatMs = bpm === null ? null : beatMs;
    entry.sketch.tempoSource = bpm === null ? null : source;
    return this.snapshot(entry);
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.sketch.parentId !== null) {
      this.removeTakeRow(id);
      return;
    }
    for (const e of [...this.entries.values()]) if (e.sketch.parentId === id) this.drop(e.sketch.id);
    for (const t of [...this.tracks.values()]) if (t.sketchId === id) this.tracks.delete(t.id);
    this.drop(id);
  }

  async setTranscriptionStatus(id: string, status: TranscriptionStatus, error: string | null = null) {
    const entry = this.entry(id);
    entry.sketch.transcriptionStatus = status;
    entry.sketch.transcriptionError = error;
    return this.snapshot(entry);
  }

  async saveTranscription(args: SaveTranscriptionArgs): Promise<SketchDetail> {
    const entry = this.entry(args.id);
    validate(args.notes);
    entry.transcription = {
      engine: args.engine,
      engineVersion: args.engineVersion,
      params: clone(args.params),
      originalNotes: clone(args.notes),
      editedNotes: null,
      createdAt: Date.now(),
      editedAt: null,
    };
    Object.assign(entry.sketch, {
      summary: args.summary,
      hasEdits: false,
      transcriptionStatus: 'done',
      transcriptionError: null,
    } satisfies Partial<Sketch>);
    return this.get(args.id);
  }

  async saveEdits(args: SaveEditsArgs): Promise<SketchDetail> {
    const entry = this.entry(args.id);
    if (!entry.transcription) throw new Error(`sketch ${args.id} has no transcription to edit`);
    validate(args.notes);
    entry.transcription.editedNotes = clone(args.notes);
    entry.transcription.editedAt = Date.now();
    entry.sketch.hasEdits = true;
    if (args.summary) entry.sketch.summary = args.summary;
    return this.get(args.id);
  }

  async resetEdits(id: string, summary: SketchSummary | null): Promise<SketchDetail> {
    const entry = this.entry(id);
    if (entry.transcription) {
      entry.transcription.editedNotes = null;
      entry.transcription.editedAt = null;
    }
    entry.sketch.hasEdits = false;
    if (summary) entry.sketch.summary = summary;
    return this.get(id);
  }

  async writeFile(id: string, kind: FileKind, bytes: Uint8Array): Promise<string> {
    const entry = this.entry(id);
    if (kind === 'media-chunk') {
      if (entry.sketch.status !== 'recording') {
        throw new Error('the recording is already saved and cannot be modified');
      }
      entry.chunks.push(bytes.slice());
      return entry.sketch.mediaPath ?? '';
    }
    const type = kind === 'midi' ? 'audio/midi' : 'audio/wav';
    const previous = entry.files.get(kind);
    if (previous) URL.revokeObjectURL(previous.url);
    const blob = new Blob([bytes.slice()], { type });
    const url = URL.createObjectURL(blob);
    entry.files.set(kind, { blob, url });
    if (kind === 'analysis') entry.sketch.analysisPath = url;
    return url;
  }

  async prepareExport(id: string, _baseName: string, kinds: ExportKind[]): Promise<ExportBundle> {
    const entry = this.entry(id);
    const sources: Record<ExportKind, string> = {
      recording: 'media',
      audio: 'take-audio',
      'notes-audio': 'notes-audio',
      midi: 'midi',
    };
    const bundle: ExportBundle = { files: [], missing: [] };
    for (const kind of new Set(kinds)) {
      const file = entry.files.get(sources[kind]);
      if (file) bundle.files.push({ kind, path: file.url });
      else bundle.missing.push(kind);
    }
    return bundle;
  }

  async copyOut(): Promise<void> {
    throw new Error('copyOut is not available in the browser');
  }

  // ------------------------------------------------------------ notebooks

  private notebook(id: string): Notebook {
    const notebook = this.notebooks.get(id);
    if (!notebook) throw new Error(`notebook not found: ${id}`);
    return notebook;
  }

  async listNotebooks(): Promise<Notebook[]> {
    return [...this.notebooks.values()].sort((a, b) => a.createdAt - b.createdAt).map((n) => ({ ...n }));
  }

  async createNotebook(title: string): Promise<Notebook> {
    // Strictly increasing, so the order of creation is kept within one millisecond.
    const last = Math.max(0, ...[...this.notebooks.values()].map((n) => n.createdAt));
    const now = Math.max(Date.now(), last + 1);
    const notebook: Notebook = { id: newId(), title: title.trim().slice(0, 120), createdAt: now, updatedAt: now, loopStartMs: null, loopEndMs: null };
    this.notebooks.set(notebook.id, notebook);
    return { ...notebook };
  }

  async renameNotebook(id: string, title: string): Promise<Notebook> {
    const notebook = this.notebook(id);
    notebook.title = title.trim().slice(0, 120);
    notebook.updatedAt = Date.now();
    return { ...notebook };
  }

  async setNotebookLoop(id: string, startMs: number | null, endMs: number | null): Promise<Notebook> {
    const notebook = this.notebook(id);
    if (startMs !== null && endMs !== null) {
      if (startMs < 0 || endMs - startMs < 250) throw new Error('the loop range is too short');
      notebook.loopStartMs = Math.round(startMs);
      notebook.loopEndMs = Math.round(endMs);
    } else {
      notebook.loopStartMs = null;
      notebook.loopEndMs = null;
    }
    notebook.updatedAt = Date.now();
    return { ...notebook };
  }

  async removeNotebook(id: string): Promise<void> {
    this.notebook(id);
    for (const e of [...this.entries.values()]) {
      if (e.sketch.notebookId === id && e.sketch.parentId === null) await this.remove(e.sketch.id);
    }
    this.notebooks.delete(id);
  }

  async placeSketch(args: PlaceSketchArgs): Promise<Sketch> {
    const entry = this.entry(args.id);
    if (entry.sketch.parentId !== null) throw new Error(`sketch not found: ${args.id}`);
    if (args.notebookId) this.notebook(args.notebookId);
    entry.sketch.notebookId = args.notebookId ?? entry.sketch.notebookId;
    entry.sketch.canvasXMs = Math.round(args.canvasXMs);
    entry.sketch.canvasY = validY(args.canvasY);
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  async setRepeats(id: string, repeats: number): Promise<Sketch> {
    const entry = this.entry(id);
    if (entry.sketch.parentId !== null) throw new Error(`sketch not found: ${id}`);
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_CANVAS_REPEATS) throw new Error(`${repeats} repeats is out of range`);
    entry.sketch.canvasRepeats = repeats;
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  async setVolume(id: string, volume: number): Promise<Sketch> {
    const entry = this.entry(id);
    if (entry.sketch.parentId !== null) throw new Error(`sketch not found: ${id}`);
    if (!(volume >= 0 && volume <= 1)) throw new Error(`volume ${volume} is out of range`);
    entry.sketch.canvasVolume = volume;
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  async duplicate(args: DuplicateSketchArgs): Promise<Sketch> {
    const source = this.entry(args.id);
    this.notebook(args.notebookId);
    if (source.sketch.parentId !== null) throw new Error('only a sketch can be copied, not a take of one');
    if (source.sketch.status !== 'saved') throw new Error('that sketch is still being recorded');
    const id = newId();
    const now = Date.now();
    // The same blobs under URLs of its own, so revoking one sketch's URLs leaves the other's.
    const files = new Map<string, { blob: Blob; url: string }>();
    for (const [kind, file] of source.files) files.set(kind, { blob: file.blob, url: URL.createObjectURL(file.blob) });
    const url = (path: string | null) => {
      if (!path) return null;
      for (const [kind, file] of source.files) if (file.url === path) return files.get(kind)!.url;
      return path;
    };
    const trackId = source.sketch.trackId ? newId() : null;
    const status = source.sketch.transcriptionStatus === 'running' ? 'pending' : source.sketch.transcriptionStatus;
    this.entries.set(id, {
      sketch: {
        ...clone(source.sketch),
        id,
        updatedAt: now,
        mediaPath: url(source.sketch.mediaPath),
        analysisPath: url(source.sketch.analysisPath),
        transcriptionStatus: status,
        recovered: false,
        parentId: null,
        trackId,
        notebookId: args.notebookId,
        canvasXMs: Math.round(args.canvasXMs),
        canvasY: validY(args.canvasY),
      },
      transcription: source.transcription ? clone(source.transcription) : null,
      chunks: [],
      files,
    });
    if (trackId) {
      this.tracks.set(trackId, { id: trackId, sketchId: id, position: 0, name: 'Track 1', takeId: id, muted: false, solo: false, collapsed: false, createdAt: now });
    }
    return this.snapshot(this.entry(id));
  }

  async createRhythm(args: CreateRhythmArgs): Promise<Sketch> {
    this.notebook(args.notebookId);
    const id = newId();
    const now = Date.now();
    this.entries.set(id, {
      sketch: {
        id,
        title: (args.title ?? '').trim(),
        createdAt: now,
        updatedAt: now,
        status: 'saved',
        durationMs: Math.round(args.durationMs),
        mediaPath: null,
        mediaMime: null,
        hasVideo: false,
        videoWidth: null,
        videoHeight: null,
        analysisPath: null,
        textNotes: '',
        transcriptionStatus: 'done',
        transcriptionError: null,
        captureBackend: 'rhythm-pads',
        recovered: false,
        summary: null,
        hasEdits: false,
        listenMode: 'recording',
        cropStartMs: null,
        cropEndMs: null,
        parentId: null,
        trackId: null,
        offsetMs: 0,
        countInMs: null,
        tempoBpm: null,
        beatMs: null,
        tempoSource: null,
        notebookId: args.notebookId,
        canvasXMs: Math.round(args.canvasXMs),
        canvasY: validY(args.canvasY),
        kind: 'rhythm',
        rhythm: clone(args.rhythm),
        canvasRepeats: 1,
        canvasVolume: 1,
        noteSampleId: null,
        canvasW: null,
        canvasH: null,
      },
      transcription: null,
      chunks: [],
      files: new Map(),
    });
    return this.snapshot(this.entry(id));
  }

  async createTextNote(args: CreateTextNoteArgs): Promise<Sketch> {
    this.notebook(args.notebookId);
    if (args.text.length > 20_000) throw new Error('the note is too long');
    const id = newId();
    const now = Date.now();
    this.entries.set(id, {
      sketch: {
        id,
        title: '',
        createdAt: now,
        updatedAt: now,
        status: 'saved',
        durationMs: null,
        mediaPath: null,
        mediaMime: null,
        hasVideo: false,
        videoWidth: null,
        videoHeight: null,
        analysisPath: null,
        textNotes: args.text,
        transcriptionStatus: 'done',
        transcriptionError: null,
        captureBackend: 'text',
        recovered: false,
        summary: null,
        hasEdits: false,
        listenMode: 'recording',
        cropStartMs: null,
        cropEndMs: null,
        parentId: null,
        trackId: null,
        offsetMs: 0,
        countInMs: null,
        tempoBpm: null,
        beatMs: null,
        tempoSource: null,
        notebookId: args.notebookId,
        canvasXMs: Math.round(args.canvasXMs),
        canvasY: validY(args.canvasY),
        kind: 'text',
        rhythm: null,
        canvasRepeats: 1,
        canvasVolume: 1,
        noteSampleId: null,
        canvasW: validBox(args.canvasW ?? null),
        canvasH: validBox(args.canvasH ?? null),
      },
      transcription: null,
      chunks: [],
      files: new Map(),
    });
    return this.snapshot(this.entry(id));
  }

  async updateTextNote(args: UpdateTextNoteArgs): Promise<Sketch> {
    const entry = this.entry(args.id);
    if (entry.sketch.kind !== 'text') throw new Error(`text note not found: ${args.id}`);
    if (args.text !== undefined) {
      if (args.text.length > 20_000) throw new Error('the note is too long');
      entry.sketch.textNotes = args.text;
    }
    if (args.clearSize) {
      entry.sketch.canvasW = null;
      entry.sketch.canvasH = null;
    } else {
      if (args.canvasW !== undefined) entry.sketch.canvasW = validBox(args.canvasW);
      if (args.canvasH !== undefined) entry.sketch.canvasH = validBox(args.canvasH);
    }
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  async updateRhythm(args: UpdateRhythmArgs): Promise<Sketch> {
    const entry = this.entry(args.id);
    if (entry.sketch.kind !== 'rhythm') throw new Error(`rhythm sketch not found: ${args.id}`);
    entry.sketch.rhythm = clone(args.rhythm);
    entry.sketch.durationMs = Math.round(args.durationMs);
    entry.sketch.updatedAt = Date.now();
    return this.snapshot(entry);
  }

  // -------------------------------------------------------------- samples

  async listSamples(): Promise<Sample[]> {
    return [...this.samples.values()].map((e) => clone(e.sample)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async createSample(args: CreateSampleArgs, wav: Uint8Array): Promise<Sample> {
    if (wav.length < 44 || String.fromCharCode(...wav.slice(0, 4)) !== 'RIFF') throw new Error('a sample must be a WAV file');
    if (args.durationMs != null && !(args.durationMs >= 1 && args.durationMs <= 60_000)) throw new Error(`a sample of ${args.durationMs} ms is out of range`);
    const id = newId();
    const now = Date.now();
    const url = URL.createObjectURL(new Blob([wav.slice()], { type: 'audio/wav' }));
    const sample: Sample = {
      id,
      title: (args.title ?? '').trim().slice(0, 120),
      createdAt: now,
      updatedAt: now,
      durationMs: args.durationMs ?? null,
      audioPath: url,
      sourceSketchId: args.sourceSketchId ?? null,
      sourceStartMs: args.sourceStartMs ?? null,
      sourceEndMs: args.sourceEndMs ?? null,
      settings: clone(args.settings ?? {}),
    };
    this.samples.set(id, { sample, url });
    return clone(sample);
  }

  async updateSample(args: UpdateSampleArgs): Promise<Sample> {
    const entry = this.samples.get(args.id);
    if (!entry) throw new Error(`sample not found: ${args.id}`);
    if (args.settings !== undefined && (typeof args.settings !== 'object' || args.settings === null)) throw new Error('sample settings must be an object');
    entry.sample = {
      ...entry.sample,
      title: args.title !== undefined ? args.title.trim().slice(0, 120) : entry.sample.title,
      settings: args.settings !== undefined ? clone(args.settings) : entry.sample.settings,
      updatedAt: Math.max(Date.now(), entry.sample.updatedAt + 1),
    };
    return clone(entry.sample);
  }

  async removeSample(id: string): Promise<void> {
    const entry = this.samples.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.samples.delete(id);
    for (const e of this.entries.values()) if (e.sketch.noteSampleId === id) e.sketch.noteSampleId = null;
  }

  async setNoteSample(id: string, sampleId: string | null): Promise<Sketch> {
    const entry = this.entry(id);
    if (entry.sketch.parentId !== null) throw new Error(`sketch not found: ${id}`);
    if (sampleId !== null && !this.samples.has(sampleId)) throw new Error(`sample not found: ${sampleId}`);
    entry.sketch.noteSampleId = sampleId;
    entry.sketch.updatedAt = Math.max(Date.now(), entry.sketch.updatedAt + 1);
    return this.snapshot(entry);
  }
}

function validBox(px: number | null): number | null {
  if (px === null) return null;
  if (!Number.isFinite(px) || px < 16 || px > 4000) throw new Error(`note size ${px} is out of range`);
  return px;
}

function validY(y: number): number {
  if (!Number.isFinite(y) || y < 0 || y > 1_000_000) throw new Error(`canvas position ${y} is out of range`);
  return y;
}

function validate(notes: PianoNote[]) {
  for (const [i, n] of notes.entries()) {
    if (!(n.endTime > n.startTime) || n.startTime < 0 || n.pitch < 0 || n.pitch > 127) {
      throw new Error(`note ${i}: invalid note`);
    }
  }
}
