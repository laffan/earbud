/** Sketch Library backed by the Rust/SQLite commands in `src-tauri`. */
import { invoke } from '../platform/tauri';
import type { SketchSummary } from '../music/summary';
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
  TranscriptionStatus,
  UpdateRhythmArgs,
  UpdateTextNoteArgs,
  UpdateSketchArgs,
  UpdateTrackArgs,
} from './types';

export class TauriLibrary implements SketchLibrary {
  readonly persistent = true;

  recover() {
    return invoke<RecoveryReport>('recover_sketches');
  }
  list() {
    return invoke<Sketch[]>('list_sketches');
  }
  get(id: string) {
    return invoke<SketchDetail>('get_sketch', { id });
  }
  create(args: CreateSketchArgs) {
    return invoke<CreatedSketch>('create_sketch', { args });
  }
  finalize(args: FinalizeSketchArgs) {
    return invoke<Sketch>('finalize_sketch', { args });
  }
  discard(id: string) {
    return invoke<void>('discard_sketch', { id });
  }
  update(args: UpdateSketchArgs) {
    return invoke<Sketch>('update_sketch', { args });
  }
  remove(id: string) {
    return invoke<void>('delete_sketch', { id });
  }
  updateTrack(args: UpdateTrackArgs) {
    return invoke<Track>('update_track', { args });
  }
  removeTrack(id: string) {
    return invoke<void>('delete_track', { id });
  }
  removeTake(id: string) {
    return invoke<void>('delete_take', { id });
  }
  setCrop(id: string, startMs: number | null, endMs: number | null) {
    return invoke<Sketch>('set_crop', { id, startMs, endMs });
  }
  setTempo(id: string, bpm: number | null, beatMs: number | null, source: TempoSource | null) {
    return invoke<Sketch>('set_tempo', { id, bpm, beatMs, source });
  }
  setTranscriptionStatus(id: string, status: TranscriptionStatus, error: string | null = null) {
    return invoke<Sketch>('set_transcription_status', { id, status, error });
  }
  saveTranscription(args: SaveTranscriptionArgs) {
    return invoke<SketchDetail>('save_transcription', { args });
  }
  saveEdits(args: SaveEditsArgs) {
    return invoke<SketchDetail>('save_edits', { args });
  }
  resetEdits(id: string, summary: SketchSummary | null) {
    return invoke<SketchDetail>('reset_edits', { id, summary });
  }
  writeFile(id: string, kind: FileKind, bytes: Uint8Array) {
    // Raw IPC body: no JSON/base64 encoding of the bytes.
    return invoke<string>('write_sketch_file', bytes, {
      headers: { 'x-sketch-id': id, 'x-file-kind': kind },
    });
  }
  prepareExport(id: string, baseName: string, kinds: ExportKind[]) {
    return invoke<ExportBundle>('prepare_export', { id, baseName, kinds });
  }
  copyOut(src: string, dest: string) {
    return invoke<void>('copy_out', { src, dest });
  }
  listNotebooks() {
    return invoke<Notebook[]>('list_notebooks');
  }
  createNotebook(title: string) {
    return invoke<Notebook>('create_notebook', { title });
  }
  renameNotebook(id: string, title: string) {
    return invoke<Notebook>('rename_notebook', { id, title });
  }
  setNotebookLoop(id: string, startMs: number | null, endMs: number | null) {
    return invoke<Notebook>('set_notebook_loop', { id, startMs, endMs });
  }
  removeNotebook(id: string) {
    return invoke<void>('delete_notebook', { id });
  }
  placeSketch(args: PlaceSketchArgs) {
    return invoke<Sketch>('place_sketch', { args });
  }
  setRepeats(id: string, repeats: number) {
    return invoke<Sketch>('set_sketch_repeats', { id, repeats });
  }
  setVolume(id: string, volume: number) {
    return invoke<Sketch>('set_sketch_volume', { id, volume });
  }
  duplicate(args: DuplicateSketchArgs) {
    return invoke<Sketch>('duplicate_sketch', { args });
  }
  createRhythm(args: CreateRhythmArgs) {
    return invoke<Sketch>('create_rhythm', { args });
  }
  createTextNote(args: CreateTextNoteArgs) {
    return invoke<Sketch>('create_text_note', { args });
  }
  updateTextNote(args: UpdateTextNoteArgs) {
    return invoke<Sketch>('update_text_note', { args: { ...args, clearSize: args.clearSize ?? false } });
  }
  updateRhythm(args: UpdateRhythmArgs) {
    return invoke<Sketch>('update_rhythm', { args });
  }
  listSamples() {
    return invoke<Sample[]>('list_samples');
  }
  async createSample(args: CreateSampleArgs, wav: Uint8Array) {
    const created = await invoke<Sample>('create_sample', { args });
    try {
      // Raw IPC body: no JSON/base64 encoding of the audio.
      return await invoke<Sample>('write_sample_audio', wav, { headers: { 'x-sample-id': created.id } });
    } catch (error) {
      await invoke<void>('delete_sample', { id: created.id }).catch(() => {});
      throw error;
    }
  }
  updateSample(args: UpdateSampleArgs) {
    return invoke<Sample>('update_sample', { args });
  }
  removeSample(id: string) {
    return invoke<void>('delete_sample', { id });
  }
  setNoteSample(id: string, sampleId: string | null) {
    return invoke<Sketch>('set_note_sample', { id, sampleId });
  }
}
