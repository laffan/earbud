import type { Sketch, SketchLibrary } from '../library/types';
import { notesEndTime } from '../music/notes';
import { renderNotesBuffer } from '../music/synth';
import type { PianoNote } from '../transcription/types';
import { loadTakeBuffer, type DecodeDeps, type TakeAudioSource } from './takeBuffers';

export interface AudioLayer {
  buffer: AudioBuffer;
  offset: number;
}

export interface CanvasSound {
  buffer: AudioBuffer;
  /** Recording-only signal for the waveform, even in Both mode. */
  recording: AudioBuffer | null;
  /** Current edited notes, in the canvas tile's source-time coordinates. */
  notes: PianoNote[];
  duration: number;
}

interface Dependencies extends DecodeDeps {
  load?: (ctx: BaseAudioContext, take: TakeAudioSource, deps: DecodeDeps) => Promise<AudioBuffer>;
  renderNotes?: typeof renderNotesBuffer;
  mix?: typeof mixAudioLayers;
}

/** Prepare exactly the selected sound, sharing the sketch view's active takes, mute/solo and edits. */
export async function loadCanvasSound(
  ctx: BaseAudioContext,
  sketch: Sketch,
  library: Pick<SketchLibrary, 'get'>,
  deps: Dependencies = {},
): Promise<CanvasSound> {
  const detail = await library.get(sketch.id);
  const mode = sketch.listenMode ?? 'recording';
  const anySolo = detail.tracks.some((t) => t.solo);
  const selected = detail.tracks.length
    ? detail.tracks.flatMap((t) => {
        const take = t.takes.find((take) => take.id === t.takeId && take.status === 'saved');
        return take ? [{ take, audible: !t.muted && (!anySolo || t.solo) }] : [];
      })
    : [{ take: detail, audible: true }];
  const recordings: AudioLayer[] = [];
  const notes: PianoNote[] = [];
  let duration = (sketch.durationMs ?? 0) / 1000;
  let failed = 0;
  await Promise.all(selected.map(async ({ take, audible }) => {
    // Canvas positions/count-in refer to the original recording's time 0;
    // track offsets in the detail view refer to the sketch's timeline.
    const offset = (take.offsetMs - detail.offsetMs) / 1000;
    duration = Math.max(duration, offset + (take.durationMs ?? 0) / 1000);
    if (!audible) return;
    if (mode !== 'recording') {
      const source = take.id === detail.id ? detail : await library.get(take.id);
      const current = (source.transcription?.editedNotes ?? source.transcription?.originalNotes ?? []).map(n => ({ ...n, startTime: n.startTime + (take.audioMidiOffsetMs ?? 0) / 1000, endTime: n.endTime + (take.audioMidiOffsetMs ?? 0) / 1000 }));
      notes.push(...current.filter((n) => n.endTime + offset > 0).map((n) => ({
        ...n, startTime: Math.max(0, n.startTime + offset), endTime: n.endTime + offset,
      })));
    }
    if (mode !== 'notes') {
      try {
        const buffer = await (deps.load ?? loadTakeBuffer)(ctx, take, deps);
        recordings.push({ buffer, offset });
        duration = Math.max(duration, offset + buffer.duration);
      } catch (error) {
        failed++;
        deps.log?.(`could not decode a take: ${String(error)}`);
      }
    }
  }));
  notes.sort((a, b) => a.startTime - b.startTime || a.pitch - b.pitch);
  duration = Math.max(duration, notesEndTime(notes), 0.5);
  if (failed && !recordings.length && (mode === 'recording' || !notes.length)) {
    throw new Error('No selected sound could be loaded');
  }
  const mix = deps.mix ?? mixAudioLayers;
  const recording = recordings.length ? await mix(recordings, duration, ctx.sampleRate) : null;
  const layers: AudioLayer[] = recording ? [{ buffer: recording, offset: 0 }] : [];
  if (mode !== 'recording' && notes.length) {
    layers.push({ buffer: await (deps.renderNotes ?? renderNotesBuffer)(notes, { sampleRate: ctx.sampleRate }), offset: 0 });
  }
  return { buffer: await mix(layers, duration, ctx.sampleRate), recording, notes, duration };
}

/** Web Audio handles sample-rate conversion and mono/stereo mixing, including analysis WAV fallbacks. */
export async function mixAudioLayers(layers: AudioLayer[], duration: number, sampleRate: number): Promise<AudioBuffer> {
  if (layers.length === 1 && layers[0].offset === 0) return layers[0].buffer;
  const OfflineCtx = window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const channels = Math.max(1, ...layers.map((l) => l.buffer.numberOfChannels));
  const ctx = new OfflineCtx(channels, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);
  for (const { buffer, offset } of layers) {
    if (offset + buffer.duration <= 0 || offset >= duration) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(Math.max(0, offset), Math.max(0, -offset));
  }
  return new Promise((resolve, reject) => {
    ctx.oncomplete = (event) => resolve(event.renderedBuffer);
    const result = ctx.startRendering() as Promise<AudioBuffer> | undefined;
    result?.then(resolve, reject);
  });
}
