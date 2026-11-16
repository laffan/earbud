/**
 * Importing a file as a new sketch on a notebook's canvas.
 *
 * - Audio (or a video's sound): the file is copied in as the sketch's
 *   recording, untouched, and transcribed like any recording.
 * - MIDI: the file's notes become the sketch's notes as they are (no
 *   transcription), and the built-in piano renders them to audio: at full
 *   quality as the sketch's "recording", and at 22.05 kHz as its analysis
 *   audio, which is what its waveform is drawn from.
 *
 * Both go through the same library calls as a recording (a reserved sketch,
 * then chunks, then finalize), so a failed import leaves nothing behind.
 */
import { ANALYSIS_SAMPLE_RATE } from '../audio/analysisAudio';
import { midiFileToNotes, notesToMidi } from '../music/midi';
import { notesEndTime } from '../music/notes';
import { summarize } from '../music/summary';
import { renderNotesToWav } from '../music/synth';
import type { PianoNote } from '../transcription/types';
import type { Sketch, SketchLibrary } from './types';

export const IMPORT_CAPTURE_BACKEND = 'import';
export const MIDI_IMPORT_ENGINE = 'midi-import';
/** Chords tapped on the circle of fifths in the Reference section. */
export const CHORD_TAPS_BACKEND = 'chord-taps';
export const CHORD_TAPS_ENGINE = 'chord-taps';

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

export interface ImportedSketch {
  sketch: Sketch;
  /** It still needs transcribing (audio); MIDI arrives with its notes. */
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

/** Where an imported sketch goes: a notebook's canvas, its recording's time 0 at `canvasXMs`. */
export interface Placement {
  notebookId: string;
  canvasXMs: number;
  canvasY: number;
}

/** Reserve a sketch on a canvas, fill it with `fill`, and finalize it; undo everything on failure. */
async function newSketch(
  library: SketchLibrary,
  name: string,
  place: Placement,
  media: { extension: string; mime: string },
  fill: (id: string) => Promise<Parameters<SketchLibrary['finalize']>[0]>,
  captureBackend = IMPORT_CAPTURE_BACKEND,
): Promise<Sketch> {
  const created = await library.create({
    mediaExtension: media.extension,
    mediaMime: media.mime,
    captureBackend,
    title: name,
    notebookId: place.notebookId,
    canvasXMs: Math.round(place.canvasXMs),
    canvasY: place.canvasY,
  });
  try {
    return await library.finalize(await fill(created.id));
  } catch (error) {
    await library.discard(created.id).catch(() => {});
    throw error;
  }
}

/** Import an audio (or video) file as a new sketch on a canvas. */
export async function importAudioSketch(deps: ImportDeps, file: File, place: Placement): Promise<ImportedSketch> {
  const probe = await (deps.probe ?? probeMedia)(file);
  const name = fileStem(file.name);
  const sketch = await newSketch(
    deps.library,
    name,
    place,
    { extension: extensionOf(file), mime: file.type || 'application/octet-stream' },
    async (id) => {
      await upload(deps.library, id, file);
      return { id, durationMs: probe.durationMs, hasVideo: probe.hasVideo, videoWidth: probe.width, videoHeight: probe.height };
    },
  );
  return { sketch, transcribe: true };
}

/** Import a MIDI file as a new sketch on a canvas: its notes, played by the built-in piano. */
export async function importMidiSketch(deps: ImportDeps, file: File, place: Placement): Promise<ImportedSketch> {
  let notes: PianoNote[];
  try {
    notes = midiFileToNotes(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error(`${file.name} is not a MIDI file that can be read`);
  }
  if (notes.length === 0) throw new Error(`${file.name} has no notes to import`);
  const sketch = await notesSketch(deps, notes, fileStem(file.name), place, {
    engine: MIDI_IMPORT_ENGINE,
    params: { file: file.name },
    midi: new Uint8Array(await file.arrayBuffer()),
  });
  return { sketch, transcribe: false };
}

/**
 * A new sketch on a canvas from notes (no recording, nothing to transcribe):
 * the built-in piano renders them as its "recording" and its analysis audio
 * (which its waveform is drawn from), and they are saved as its notes.
 */
export async function notesSketch(
  deps: ImportDeps,
  notes: PianoNote[],
  name: string,
  place: Placement,
  source: { engine: string; params: Record<string, unknown>; midi?: Uint8Array; captureBackend?: string },
): Promise<Sketch> {
  if (notes.length === 0) throw new Error('there are no notes');
  const render = deps.render ?? ((n, sampleRate) => renderNotesToWav(n, { sampleRate }));
  const { library } = deps;
  const sketch = await newSketch(
    library,
    name,
    place,
    { extension: 'wav', mime: 'audio/wav' },
    async (id) => {
      await upload(library, id, await render(notes, 44100));
      return {
        id,
        durationMs: Math.round((notesEndTime(notes) + 1.5) * 1000),
        hasVideo: false,
        videoWidth: null,
        videoHeight: null,
      };
    },
    source.captureBackend,
  );
  try {
    // The waveform is drawn from the analysis audio; the notes are the source's.
    await library.writeFile(sketch.id, 'analysis', await render(notes, ANALYSIS_SAMPLE_RATE));
    const detail = await library.saveTranscription({
      id: sketch.id,
      engine: source.engine,
      engineVersion: '1',
      params: source.params,
      notes,
      summary: summarize(notes),
    });
    await library.writeFile(sketch.id, 'midi', source.midi ?? notesToMidi(notes));
    // The row as lists hold it, without the transcription and tracks.
    const { transcription: _transcription, tracks: _tracks, ...row } = detail;
    return row;
  } catch (error) {
    // The sketch is saved by now: remove it rather than leave half of it.
    await library.remove(sketch.id).catch(() => {});
    throw error;
  }
}
