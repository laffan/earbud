/**
 * Export / share: prepares the files the user picked (original recording,
 * the take's audio, the notes rendered as audio, MIDI) for one or more
 * sketches, then hands them to the platform (iOS share sheet, desktop folder,
 * browser download). Derived files are written next to the recording; the
 * recording itself is only read.
 */
import { decodeMediaToWav } from '../audio/analysisAudio';
import { shareFiles, type CaptureEngine, type PlatformCapabilities } from '../capture';
import { takeAudioPathFor, type ExportKind, type SketchDetail, type SketchLibrary } from '../library/types';
import { notesToMidi } from '../music/midi';
import { renderNotesToWav } from '../music/synth';
import { errorMessage, fileUrl } from '../platform/tauri';
import { displayTitle, exportBaseName } from '../ui/format';

export const EXPORT_KINDS: ExportKind[] = ['recording', 'audio', 'notes-audio', 'midi'];

export interface ExportFile {
  kind: ExportKind;
  path: string;
  /** File name to use when the platform cannot infer one (browser downloads). */
  name: string;
}

export interface ExportResult {
  files: ExportFile[];
  /** Human-readable notes about things that could not be included. */
  skipped: string[];
}

export interface ExportDeps {
  library: SketchLibrary;
  capture: CaptureEngine | null;
}

export function recordingExtension(mime: string | null): string {
  if (!mime || mime.includes('quicktime')) return 'mov';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return mime.startsWith('audio') ? 'weba' : 'webm';
  if (mime.startsWith('audio/mp4')) return 'm4a';
  return 'mp4';
}

function downloadName(base: string, kind: ExportKind, detail: SketchDetail): string {
  switch (kind) {
    case 'recording':
      return `${base}.${recordingExtension(detail.mediaMime)}`;
    case 'audio':
      return `${base} (audio).wav`;
    case 'notes-audio':
      return `${base} (notes).wav`;
    case 'midi':
      return `${base}.mid`;
  }
}

/** Make sure the take's audio track exists as a file next to the recording. */
async function ensureTakeAudio(detail: SketchDetail, deps: ExportDeps): Promise<void> {
  const { library, capture } = deps;
  if (!detail.mediaPath) throw new Error('the sketch has no recording');
  if (capture?.exportAudio && detail.captureBackend === capture.id) {
    try {
      await capture.exportAudio(detail.mediaPath, takeAudioPathFor(detail.mediaPath));
      return;
    } catch (error) {
      console.warn('[earbud] native audio export failed, decoding instead', error);
    }
  }
  try {
    await library.writeFile(detail.id, 'take-audio', await decodeMediaToWav(fileUrl(detail.mediaPath)));
  } catch (error) {
    // Last resort: the 22 kHz mono analysis audio (fine for listening).
    if (!detail.analysisPath) throw error;
    const response = await fetch(fileUrl(detail.analysisPath));
    await library.writeFile(detail.id, 'take-audio', new Uint8Array(await response.arrayBuffer()));
  }
}

export async function prepareExports(
  sketchIds: string[],
  kinds: ExportKind[],
  deps: ExportDeps,
  onProgress?: (message: string, fraction: number) => void,
): Promise<ExportResult> {
  const result: ExportResult = { files: [], skipped: [] };
  const wanted = EXPORT_KINDS.filter((k) => kinds.includes(k));
  for (const [index, id] of sketchIds.entries()) {
    const detail = await deps.library.get(id);
    const title = displayTitle(detail);
    const base = exportBaseName(detail);
    const progress = (step: string, part: number) =>
      onProgress?.(sketchIds.length > 1 ? `${step} (${index + 1} of ${sketchIds.length})` : step, (index + part) / sketchIds.length);
    const notes = detail.transcription ? (detail.transcription.editedNotes ?? detail.transcription.originalNotes) : [];

    try {
      if (wanted.includes('midi') && notes.length > 0) {
        progress('Writing MIDI…', 0.1);
        await deps.library.writeFile(id, 'midi', notesToMidi(notes, { title }));
      }
      if (wanted.includes('notes-audio') && notes.length > 0) {
        progress('Rendering notes…', 0.3);
        await deps.library.writeFile(id, 'notes-audio', await renderNotesToWav(notes));
      }
      if (wanted.includes('audio') && detail.mediaPath) {
        progress('Extracting audio…', 0.6);
        await ensureTakeAudio(detail, deps);
      }
    } catch (error) {
      result.skipped.push(`${title}: ${errorMessage(error)}`);
    }

    progress('Preparing files…', 0.9);
    const bundle = await deps.library.prepareExport(id, base, wanted);
    for (const file of bundle.files) {
      result.files.push({ ...file, name: downloadName(base, file.kind, detail) });
    }
    const missingNotes = bundle.missing.filter((k) => k === 'midi' || k === 'notes-audio');
    if (missingNotes.length > 0 && notes.length === 0) {
      result.skipped.push(`${title}: no transcription yet, so no notes or MIDI`);
    }
  }
  onProgress?.('Ready', 1);
  return result;
}

/**
 * Hand prepared files to the platform. Returns a short confirmation for a
 * toast, or null when the user cancelled.
 */
export async function deliverExports(files: ExportFile[], caps: PlatformCapabilities | null): Promise<string | null> {
  if (files.length === 0) throw new Error('There is nothing to export.');
  if (caps?.nativeShare) {
    const outcome = await shareFiles(files.map((f) => f.path));
    return outcome.completed ? 'Shared.' : null;
  }
  if (caps?.tauri) {
    const [{ open }, { basename, join }, { invoke }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/api/path'),
      import('../platform/tauri'),
    ]);
    const dir = await open({ directory: true, title: 'Export to folder' });
    if (typeof dir !== 'string') return null;
    const used = new Set<string>();
    for (const file of files) {
      let name = await basename(file.path);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
      used.add(name.toLowerCase());
      await invoke('copy_out', { src: file.path, dest: await join(dir, name) });
    }
    return `Exported ${files.length} file${files.length === 1 ? '' : 's'} to ${dir}.`;
  }
  // Browser preview: download each file.
  for (const file of files) {
    const a = document.createElement('a');
    a.href = file.path;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
  }
  return `Downloaded ${files.length} file${files.length === 1 ? '' : 's'}.`;
}
