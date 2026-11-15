/** TypeScript mirror of `src-tauri/src/library/models.rs`. */
import type { RhythmPattern } from '../music/rhythm';
import type { SketchSummary } from '../music/summary';
import type { PianoNote } from '../transcription/types';

export type SketchStatus = 'recording' | 'saved';
export type TranscriptionStatus = 'pending' | 'running' | 'done' | 'failed';
export type ListenMode = 'recording' | 'notes' | 'both';

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
  /** What plays in the sketch and on its notebook canvas. */
  listenMode: ListenMode;
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
  /** The sketch's tempo (beats per minute), if known. */
  tempoBpm: number | null;
  /** Where one of its beats falls on the sketch's timeline (ms). */
  beatMs: number | null;
  tempoSource: TempoSource | null;
  /** The notebook whose canvas the sketch is on (null: not on any canvas). */
  notebookId: string | null;
  /** Where the recording's time 0 lies on the notebook's timeline (ms). */
  canvasXMs: number;
  /** How far down the canvas the sketch sits (canvas pixels). */
  canvasY: number;
  /** A recording, or a rhythm (a step pattern played by the drum pads; no media). */
  kind: SketchKind;
  /** The pattern of a rhythm sketch. */
  rhythm: RhythmPattern | null;
  /** How many times a recording plays in a row on the canvas (1 = once; rhythms repeat by bars instead). */
  canvasRepeats: number;
  /** A text note's box: width and minimum height in canvas pixels (null = fit the text). */
  canvasW: number | null;
  canvasH: number | null;
}

export interface CreateTextNoteArgs {
  notebookId: string;
  canvasXMs: number;
  canvasY: number;
  /** Markdown. */
  text: string;
  canvasW?: number | null;
  canvasH?: number | null;
}

export interface UpdateTextNoteArgs {
  id: string;
  text?: string;
  canvasW?: number;
  canvasH?: number;
  /** Back to fitting the text. */
  clearSize?: boolean;
}

/** Most times a recording may play in a row on the canvas. */
export const MAX_CANVAS_REPEATS = 128;

export interface DuplicateSketchArgs {
  /** The sketch to copy. */
  id: string;
  notebookId: string;
  canvasXMs: number;
  canvasY: number;
}

/** A recording, a rhythm (a step pattern, no media), or a text note (markdown in `textNotes`). */
export type SketchKind = 'audio' | 'rhythm' | 'text';

/** A notebook: a canvas of sketches placed on one timeline. */
export interface Notebook {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Where repeat loops on the timeline (ms); null = from the first sketch to the end of the last. */
  loopStartMs: number | null;
  loopEndMs: number | null;
}

export interface PlaceSketchArgs {
  id: string;
  /** Move it to another notebook (omitted: stays on its own). */
  notebookId?: string;
  canvasXMs: number;
  canvasY: number;
}

export interface CreateRhythmArgs {
  notebookId: string;
  canvasXMs: number;
  canvasY: number;
  title?: string;
  rhythm: RhythmPattern;
  /** How long it plays on the canvas (ms). */
  durationMs: number;
}

export interface UpdateRhythmArgs {
  id: string;
  rhythm: RhythmPattern;
  durationMs: number;
}

/** Where a sketch's tempo came from. */
export type TempoSource = 'detected' | 'count-in' | 'user';

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
  /** A new sketch: the notebook it goes on, and where (see `Sketch.canvasXMs`, `Sketch.canvasY`). */
  notebookId?: string;
  canvasXMs?: number;
  canvasY?: number;
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
  /** Where the recording's time 0 lies on its notebook's timeline (ms). */
  canvasXMs?: number;
}

export interface UpdateSketchArgs {
  id: string;
  title?: string;
  textNotes?: string;
  durationMs?: number;
  listenMode?: ListenMode;
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
  /** Set (or clear, with a null tempo) the sketch's tempo and where one of its beats falls. */
  setTempo(id: string, bpm: number | null, beatMs: number | null, source: TempoSource | null): Promise<Sketch>;
  setTranscriptionStatus(id: string, status: TranscriptionStatus, error?: string | null): Promise<Sketch>;
  saveTranscription(args: SaveTranscriptionArgs): Promise<SketchDetail>;
  saveEdits(args: SaveEditsArgs): Promise<SketchDetail>;
  resetEdits(id: string, summary: SketchSummary | null): Promise<SketchDetail>;
  /** Raw byte upload into the sketch directory; returns the written path. */
  writeFile(id: string, kind: FileKind, bytes: Uint8Array): Promise<string>;
  /** Friendly-named copies (hard links) of the requested files, for sharing. */
  prepareExport(id: string, baseName: string, kinds: ExportKind[]): Promise<ExportBundle>;
  copyOut(src: string, dest: string): Promise<void>;

  /** Every notebook, oldest first. */
  listNotebooks(): Promise<Notebook[]>;
  createNotebook(title: string): Promise<Notebook>;
  renameNotebook(id: string, title: string): Promise<Notebook>;
  /** Set (or clear, with nulls) where repeat loops. */
  setNotebookLoop(id: string, startMs: number | null, endMs: number | null): Promise<Notebook>;
  /** Delete a notebook and every sketch on it. */
  removeNotebook(id: string): Promise<void>;
  /** Move a sketch on its canvas (or onto another notebook). */
  placeSketch(args: PlaceSketchArgs): Promise<Sketch>;
  /** How many times a recording plays in a row on the canvas. */
  setRepeats(id: string, repeats: number): Promise<Sketch>;
  /** A copy of a sketch (recording, notes and settings, or rhythm) on a notebook's canvas. */
  duplicate(args: DuplicateSketchArgs): Promise<Sketch>;
  createRhythm(args: CreateRhythmArgs): Promise<Sketch>;
  createTextNote(args: CreateTextNoteArgs): Promise<Sketch>;
  updateTextNote(args: UpdateTextNoteArgs): Promise<Sketch>;
  updateRhythm(args: UpdateRhythmArgs): Promise<Sketch>;
}

/** Where the derived analysis WAV for a recording lives. */
export function analysisPathFor(mediaPath: string): string {
  return mediaPath.replace(/[^/\\]+$/, 'analysis.wav');
}

/** Where the native exporter writes the take's audio track. */
export function takeAudioPathFor(mediaPath: string): string {
  return mediaPath.replace(/[^/\\]+$/, 'take-audio.m4a');
}
