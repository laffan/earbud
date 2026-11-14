/**
 * Export / share: prepares the files the user picked (original recording,
 * the take's audio, the notes rendered as audio, MIDI) for one or more
 * sketches, then hands them to the platform (iOS share sheet, desktop folder,
 * browser download). Derived files are written next to the recording; the
 * recording itself is only read.
 */
import { decodeMediaToMono, decodeMediaToWav, loadAnalysisSamples, mixParts } from '../audio/analysisAudio';
import { encodeWav16 } from '../audio/wav';
import { shareFiles, type CaptureEngine, type PlatformCapabilities } from '../capture';
import { takeAudioPathFor, type ExportKind, type SketchDetail, type SketchLibrary } from '../library/types';
import { notesToMidi, tracksToMidi } from '../music/midi';
import type { PianoNote } from '../transcription/types';
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

/** One track of a multi-track sketch, as it plays: its take, on the sketch's timeline. */
interface Part {
  name: string;
  take: SketchDetail;
  /** Seconds. */
  offset: number;
  /** On the sketch's timeline. */
  notes: PianoNote[];
  /** Not muted (and soloed, when any track is). */
  audible: boolean;
}

const MIX_RATE = 44100;

function currentNotes(detail: SketchDetail): PianoNote[] {
  return detail.transcription ? (detail.transcription.editedNotes ?? detail.transcription.originalNotes) : [];
}

/**
 * The tracks of a sketch with the takes they play. Null for a plain sketch
 * (one track, playing the sketch's own recording).
 */
async function multiTrackParts(detail: SketchDetail, library: SketchLibrary): Promise<Part[] | null> {
  const tracks = detail.tracks ?? [];
  if (tracks.length === 0 || (tracks.length === 1 && tracks[0].takeId === detail.id)) return null;
  const anySolo = tracks.some((t) => t.solo);
  const parts: Part[] = [];
  for (const track of tracks) {
    const take = track.takeId === detail.id ? detail : await library.get(track.takeId).catch(() => null);
    if (!take || take.status !== 'saved') continue;
    const offset = take.offsetMs / 1000;
    const notes = currentNotes(take)
      .map((n) => ({ ...n, startTime: n.startTime + offset, endTime: n.endTime + offset }))
      .filter((n) => n.endTime > 0)
      .map((n) => ({ ...n, startTime: Math.max(0, n.startTime) }));
    parts.push({
      name: track.name || `Track ${track.position + 1}`,
      take,
      offset,
      notes,
      audible: !track.muted && (!anySolo || track.solo),
    });
  }
  return parts;
}

/** The audible tracks' recordings mixed into one WAV (each take decoded, or its analysis audio). */
async function mixRecordedAudio(parts: Part[]): Promise<Uint8Array> {
  const decoded: { samples: Float32Array; offset: number }[] = [];
  for (const part of parts) {
    const { take } = part;
    let samples: Float32Array | null = null;
    if (take.mediaPath) {
      try {
        samples = await decodeMediaToMono(fileUrl(take.mediaPath), MIX_RATE);
      } catch (error) {
        console.warn(`[earbud] could not decode ${take.id} for the mix; using its analysis audio`, error);
      }
    }
    if (!samples && take.analysisPath) samples = await loadAnalysisSamples(take.analysisPath, MIX_RATE);
    if (!samples) throw new Error(`${part.name} has no audio to mix yet`);
    decoded.push({ samples, offset: part.offset });
  }
  return encodeWav16([mixParts(decoded, MIX_RATE)], MIX_RATE);
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
    const parts = await multiTrackParts(detail, deps.library);
    const notes = parts ? parts.flatMap((p) => p.notes) : currentNotes(detail);

    try {
      if (parts) {
        // Several tracks: MIDI has a track per track; the audio files are
        // what plays (muted tracks left out). The video is the sketch's own recording.
        const audible = parts.filter((p) => p.audible);
        if (wanted.includes('midi') && notes.length > 0) {
          progress('Writing MIDI…', 0.1);
          await deps.library.writeFile(
            id,
            'midi',
            tracksToMidi(
              parts.map((p) => ({ name: p.name, notes: p.notes })),
              { title },
            ),
          );
        }
        const audibleNotes = audible.flatMap((p) => p.notes);
        if (wanted.includes('notes-audio') && audibleNotes.length > 0) {
          progress('Rendering notes…', 0.3);
          await deps.library.writeFile(id, 'notes-audio', await renderNotesToWav(audibleNotes));
        }
        if (wanted.includes('audio') && audible.length > 0) {
          progress('Mixing the tracks…', 0.6);
          await deps.library.writeFile(id, 'take-audio', await mixRecordedAudio(audible));
        }
      } else {
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
      }
    } catch (error) {
      result.skipped.push(`${title}: ${errorMessage(error)}`);
    }

    progress('Preparing files…', 0.9);
    // The video is the take the sketch view shows: the first track's take with video.
    const shown = parts ? (parts.find((p) => p.take.hasVideo) ?? parts[0])?.take : undefined;
    const fromTake = shown && shown.id !== id && wanted.includes('recording') ? shown : null;
    const bundle = await deps.library.prepareExport(id, base, fromTake ? wanted.filter((k) => k !== 'recording') : wanted);
    const files = bundle.files.map((file) => ({ ...file, name: downloadName(base, file.kind, detail) }));
    if (fromTake) {
      const video = await deps.library.prepareExport(fromTake.id, base, ['recording']);
      files.push(...video.files.map((file) => ({ ...file, name: downloadName(base, file.kind, fromTake) })));
      bundle.missing.push(...video.missing);
    }
    files.sort((a, b) => EXPORT_KINDS.indexOf(a.kind) - EXPORT_KINDS.indexOf(b.kind));
    result.files.push(...files);
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
