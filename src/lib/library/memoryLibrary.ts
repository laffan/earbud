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
  CreateSketchArgs,
  CreatedSketch,
  ExportBundle,
  ExportKind,
  FileKind,
  FinalizeSketchArgs,
  RecoveryReport,
  SaveEditsArgs,
  SaveTranscriptionArgs,
  Sketch,
  SketchDetail,
  SketchLibrary,
  Track,
  Transcription,
  TranscriptionStatus,
  UpdateSketchArgs,
  UpdateTrackArgs,
} from './types';

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
        cropStartMs: null,
        cropEndMs: null,
        parentId: args.parentId ?? null,
        trackId,
        offsetMs: 0,
        countInMs: null,
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
}

function validate(notes: PianoNote[]) {
  for (const [i, n] of notes.entries()) {
    if (!(n.endTime > n.startTime) || n.startTime < 0 || n.pitch < 0 || n.pitch > 127) {
      throw new Error(`note ${i}: invalid note`);
    }
  }
}
