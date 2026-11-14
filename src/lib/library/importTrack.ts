/**
 * Importing a file as a new track of a sketch.
 *
 * - Audio (or a video's sound): the file is copied in as the take's
 *   recording, untouched, and transcribed like any take.
 * - MIDI: the file's notes become the take's notes as they are (no
 *   transcription), and the built-in piano renders them to audio: at full
 *   quality as the take's "recording", and at 22.05 kHz as its analysis
 *   audio, which is what its waveform is drawn from.
 *
 * Both go through the same library calls as a recording (a reserved take,
 * then chunks, then finalize), so a failed import leaves nothing behind.
 */
import { ANALYSIS_SAMPLE_RATE } from '../audio/analysisAudio';
import { midiFileToNotes } from '../music/midi';
import { notesEndTime } from '../music/notes';
import { summarize } from '../music/summary';
import { renderNotesToWav } from '../music/synth';
import type { PianoNote } from '../transcription/types';
import type { Sketch, SketchLibrary, Track } from './types';

export const IMPORT_CAPTURE_BACKEND = 'import';
export const MIDI_IMPORT_ENGINE = 'midi-import';

/** File types offered by the pickers. */
export const AUDIO_ACCEPT = 'audio/*,video/*,.wav,.mp3,.m4a,.aac,.aif,.aiff,.flac,.caf,.ogg,.opus,.webm,.mp4,.mov';
export const MIDI_ACCEPT = '.mid,.midi,audio/midi,audio/x-midi';

/** Bytes per upload call (the library appends chunks to the recording). */
const CHUNK = 4 * 1024 * 1024;

export interface MediaProbe {
  durationMs: number | null;
  hasVideo: boolean;
  width: number | null;
  height: number | null;
}

export interface ImportDeps {
  library: SketchLibrary;
  /** Length and picture of a media file (tests replace it). */
  probe?: (file: File) => Promise<MediaProbe>;
  /** Notes to WAV (tests replace it). */
  render?: (notes: PianoNote[], sampleRate: number) => Promise<Uint8Array>;
}

export interface ImportedTrack {
  take: Sketch;
  track: Track;
  /** The take still needs transcribing (audio); MIDI arrives with its notes. */
  transcribe: boolean;
}

/** "Waltz in A (take 2).mp3" → "Waltz in A (take 2)". */
export function fileStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim().slice(0, 60) || 'Imported';
}

/** The extension the library stores the recording under (letters and digits, at most five). */
function extensionOf(file: File): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(file.name);
  if (match) return match[1].toLowerCase();
  if (file.type.includes('mpeg')) return 'mp3';
  if (file.type.includes('mp4')) return 'm4a';
  if (file.type.includes('wav')) return 'wav';
  return 'bin';
}

/** Reads a media file's length (and whether it has a picture) with a media element. */
export function probeMedia(file: File, timeoutMs = 10_000): Promise<MediaProbe> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio') as HTMLVideoElement;
    let settled = false;
    const done = (probe: MediaProbe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(probe);
    };
    const unknown: MediaProbe = { durationMs: null, hasVideo: false, width: null, height: null };
    const timer = window.setTimeout(() => done(unknown), timeoutMs);
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const duration = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : null;
      const width = 'videoWidth' in el && el.videoWidth > 0 ? el.videoWidth : null;
      done({ durationMs: duration, hasVideo: width !== null, width, height: width ? el.videoHeight : null });
    };
    el.onerror = () => done(unknown);
    el.src = url;
  });
}

async function upload(library: SketchLibrary, id: string, bytes: Blob | Uint8Array) {
  const size = bytes instanceof Blob ? bytes.size : bytes.length;
  if (size === 0) throw new Error('the file is empty');
  for (let at = 0; at < size; at += CHUNK) {
    const part =
      bytes instanceof Blob
        ? new Uint8Array(await bytes.slice(at, at + CHUNK).arrayBuffer())
        : bytes.subarray(at, Math.min(size, at + CHUNK));
    await library.writeFile(id, 'media-chunk', part);
  }
}

/** Reserve a take on a new track, fill it with `write`, and finalize it; undo everything on failure. */
async function newTrack(
  library: SketchLibrary,
  sketchId: string,
  name: string,
  media: { extension: string; mime: string },
  fill: (takeId: string) => Promise<Parameters<SketchLibrary['finalize']>[0]>,
): Promise<{ take: Sketch; track: Track }> {
  const created = await library.create({
    mediaExtension: media.extension,
    mediaMime: media.mime,
    captureBackend: IMPORT_CAPTURE_BACKEND,
    title: name,
    parentId: sketchId,
  });
  try {
    const take = await library.finalize(await fill(created.id));
    const track = await library.updateTrack({ id: created.trackId, name });
    return { take, track };
  } catch (error) {
    await library.discard(created.id).catch(() => {});
    throw error;
  }
}

/** Import an audio (or video) file as a new track whose recording starts at `offsetMs`. */
export async function importAudioTrack(
  deps: ImportDeps,
  sketchId: string,
  file: File,
  offsetMs: number,
): Promise<ImportedTrack> {
  const probe = await (deps.probe ?? probeMedia)(file);
  const name = fileStem(file.name);
  const { take, track } = await newTrack(
    deps.library,
    sketchId,
    name,
    { extension: extensionOf(file), mime: file.type || 'application/octet-stream' },
    async (id) => {
      await upload(deps.library, id, file);
      return {
        id,
        durationMs: probe.durationMs,
        hasVideo: probe.hasVideo,
        videoWidth: probe.width,
        videoHeight: probe.height,
        offsetMs: Math.round(offsetMs),
      };
    },
  );
  return { take, track, transcribe: true };
}

/** Import a MIDI file as a new track: its notes, played by the built-in piano, starting at `offsetMs`. */
export async function importMidiTrack(
  deps: ImportDeps,
  sketchId: string,
  file: File,
  offsetMs: number,
): Promise<ImportedTrack> {
  let notes: PianoNote[];
  try {
    notes = midiFileToNotes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name} is not a MIDI file that can be read`);
  }
  if (notes.length === 0) throw new Error(`${file.name} has no notes to import`);
  const render = deps.render ?? ((n, sampleRate) => renderNotesToWav(n, { sampleRate }));
  const name = fileStem(file.name);
  const { library } = deps;
  const { take, track } = await newTrack(library, sketchId, name, { extension: 'wav', mime: 'audio/wav' }, async (id) => {
    await upload(library, id, await render(notes, 44100));
    return {
      id,
      durationMs: Math.round((notesEndTime(notes) + 1.5) * 1000),
      hasVideo: false,
      videoWidth: null,
      videoHeight: null,
      offsetMs: Math.round(offsetMs),
    };
  });
  const takeId = take.id;
  try {
    // The waveform is drawn from the analysis audio; the notes are the file's.
    await library.writeFile(takeId, 'analysis', await render(notes, ANALYSIS_SAMPLE_RATE));
    const detail = await library.saveTranscription({
      id: takeId,
      engine: MIDI_IMPORT_ENGINE,
      engineVersion: '1',
      params: { file: file.name },
      notes,
      summary: summarize(notes),
    });
    await library.writeFile(takeId, 'midi', new Uint8Array(await file.arrayBuffer()));
    return { take: detail, track, transcribe: false };
  } catch (error) {
    // The take is saved by now: remove its track rather than leave half an import.
    await library.removeTrack(track.id).catch(() => {});
    throw error;
  }
}
