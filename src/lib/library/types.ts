/** TypeScript mirror of `src-tauri/src/library/models.rs`. */
import type { SketchSummary } from '../music/summary';
import type { PianoNote } from '../transcription/types';

export type SketchStatus = 'recording' | 'saved';
export type TranscriptionStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Sketch {
  id: string;
  title: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  status: SketchStatus;
  durationMs: number | null;
  /** Original recording (source of truth, never modified). */
  mediaPath: string | null;
  mediaMime: string | null;
  hasVideo: boolean;
  videoWidth: number | null;
  videoHeight: number | null;
  /** Derived 22.05 kHz mono WAV, once extracted. */
  analysisPath: string | null;
  textNotes: string;
  transcriptionStatus: TranscriptionStatus;
  transcriptionError: string | null;
  captureBackend: string;
  recovered: boolean;
  summary: SketchSummary | null;
  hasEdits: boolean;
  /** Playback crop range in milliseconds (null = whole take). */
  cropStartMs: number | null;
  cropEndMs: number | null;
  /**
   * The sketch this row is a take of. Null: the row is a sketch (and the
   * first take of its first track).
   */
  parentId: string | null;
  /** The track this take belongs to. */
  trackId: string | null;
  /** Where the recording's time 0 lies on the sketch's timeline (ms; negative = before). */
  offsetMs: number;
  /** Where the count-in ended in the recording (ms), if there was one. */
  countInMs: number | null;
}

/** One track of a sketch: a lane of takes, one of which plays. */
export interface Track {
  id: string;
  sketchId: string;
  position: number;
  name: string;
  /** The take that plays. */
  takeId: string;
  muted: boolean;
  solo: boolean;
  collapsed: boolean;
  createdAt: number;
  /** Every take of the track, oldest first. */
  takes: Sketch[];
}

export interface UpdateTrackArgs {
  id: string;
  name?: string;
  muted?: boolean;
  solo?: boolean;
  collapsed?: boolean;
  /** Play another take of this track. */
  takeId?: string;
  /** Move the take that plays on the timeline (ms). */
  offsetMs?: number;
}

export interface Transcription {
  engine: string;
  engineVersion: string;
  params: Record<string, unknown>;
  originalNotes: PianoNote[];
  editedNotes: PianoNote[] | null;
  createdAt: number;
  editedAt: number | null;
}

export interface SketchDetail extends Sketch {
  transcription: Transcription | null;
  /** The sketch's tracks in order (empty for a take). */
  tracks: Track[];
}

export interface CreateSketchArgs {
  mediaExtension: string;
  mediaMime: string;
  captureBackend: string;
  title?: string;
  /** Record a take for this sketch instead of a new sketch. */
  parentId?: string;
  /** With `parentId`: the track the take is for; omitted starts a new track. */
  trackId?: string;
}

export interface CreatedSketch {
  id: string;
  dir: string;
  mediaPath: string;
  analysisPath: string;
  createdAt: number;
  trackId: string;
}

export interface FinalizeSketchArgs {
  id: string;
  durationMs: number | null;
  hasVideo: boolean;
  videoWidth: number | null;
  videoHeight: number | null;
  /** Where the take starts on the sketch's timeline (ms). */
  offsetMs?: number;
  /** Where the count-in ended in the recording (ms). */
  countInMs?: number | null;
}

export interface UpdateSketchArgs {
  id: string;
  title?: string;
  textNotes?: string;
  durationMs?: number;
}

export interface SaveTranscriptionArgs {
  id: string;
  engine: string;
  engineVersion: string;
  params: Record<string, unknown>;
  notes: PianoNote[];
  summary: SketchSummary | null;
}

export interface SaveEditsArgs {
  id: string;
  notes: PianoNote[];
  summary: SketchSummary | null;
}

export interface RecoveryReport {
  recovered: string[];
  discarded: string[];
  requeued: string[];
}

/** What can be exported from a sketch. */
export type ExportKind = 'recording' | 'audio' | 'notes-audio' | 'midi';

export interface ExportBundle {
  files: { kind: ExportKind; path: string }[];
  /** Requested kinds that had no source file. */
  missing: ExportKind[];
}

export type FileKind = 'media-chunk' | 'analysis' | 'midi' | 'notes-audio' | 'take-audio';

/** Storage backend. Implemented by Rust/SQLite in the app, in memory in dev. */
export interface SketchLibrary {
  readonly persistent: boolean;
  recover(): Promise<RecoveryReport>;
  list(): Promise<Sketch[]>;
  get(id: string): Promise<SketchDetail>;
  create(args: CreateSketchArgs): Promise<CreatedSketch>;
  finalize(args: FinalizeSketchArgs): Promise<Sketch>;
  discard(id: string): Promise<void>;
  update(args: UpdateSketchArgs): Promise<Sketch>;
  /** Delete a sketch with all of its tracks and takes (or, given a take, that take). */
  remove(id: string): Promise<void>;
  updateTrack(args: UpdateTrackArgs): Promise<Track>;
  /** Delete a track and its takes (not the one holding the sketch's own recording). */
  removeTrack(id: string): Promise<void>;
  /** Delete one take (not the sketch's own recording). */
  removeTake(id: string): Promise<void>;
  /** Set or clear (nulls) the playback crop range. The recording is untouched. */
  setCrop(id: string, startMs: number | null, endMs: number | null): Promise<Sketch>;
  setTranscriptionStatus(id: string, status: TranscriptionStatus, error?: string | null): Promise<Sketch>;
  saveTranscription(args: SaveTranscriptionArgs): Promise<SketchDetail>;
  saveEdits(args: SaveEditsArgs): Promise<SketchDetail>;
  resetEdits(id: string, summary: SketchSummary | null): Promise<SketchDetail>;
  /** Raw byte upload into the sketch directory; returns the written path. */
  writeFile(id: string, kind: FileKind, bytes: Uint8Array): Promise<string>;
  /** Friendly-named copies (hard links) of the requested files, for sharing. */
  prepareExport(id: string, baseName: string, kinds: ExportKind[]): Promise<ExportBundle>;
  copyOut(src: string, dest: string): Promise<void>;
}

/** Where the derived analysis WAV for a recording lives. */
export function analysisPathFor(mediaPath: string): string {
  return mediaPath.replace(/[^/\\]+$/, 'analysis.wav');
}

/** Where the native exporter writes the take's audio track. */
export function takeAudioPathFor(mediaPath: string): string {
  return mediaPath.replace(/[^/\\]+$/, 'take-audio.m4a');
}
