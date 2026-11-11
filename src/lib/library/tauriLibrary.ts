/** Sketch Library backed by the Rust/SQLite commands in `src-tauri`. */
import { invoke } from '../platform/tauri';
import type { SketchSummary } from '../music/summary';
import type {
  CreateSketchArgs,
  CreatedSketch,
  ExportBundle,
  FileKind,
  FinalizeSketchArgs,
  RecoveryReport,
  SaveEditsArgs,
  SaveTranscriptionArgs,
  Sketch,
  SketchDetail,
  SketchLibrary,
  TranscriptionStatus,
  UpdateSketchArgs,
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
  prepareExport(id: string, baseName: string) {
    return invoke<ExportBundle>('prepare_export', { id, baseName });
  }
  copyOut(src: string, dest: string) {
    return invoke<void>('copy_out', { src, dest });
  }
}
