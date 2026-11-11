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
  Transcription,
  TranscriptionStatus,
  UpdateSketchArgs,
} from './types';

interface Entry {
  sketch: Sketch;
  transcription: Transcription | null;
  chunks: BlobPart[];
  files: Map<string, { blob: Blob; url: string }>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryLibrary implements SketchLibrary {
  readonly persistent = false;
  private entries = new Map<string, Entry>();

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
    return { ...this.snapshot(entry), transcription: entry.transcription ? clone(entry.transcription) : null };
  }

  async create(args: CreateSketchArgs): Promise<CreatedSketch> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
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
      },
      transcription: null,
      chunks: [],
      files: new Map(),
    });
    return { id, dir, mediaPath, analysisPath: `${dir}/analysis.wav`, createdAt: now };
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
    } satisfies Partial<Sketch>);
    return this.snapshot(entry);
  }

  async discard(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.sketch.status === 'saved') throw new Error('refusing to discard a saved sketch');
    await this.remove(id);
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
    for (const f of entry.files.values()) URL.revokeObjectURL(f.url);
    this.entries.delete(id);
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
