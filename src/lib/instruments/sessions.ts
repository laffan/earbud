import { decodeMediaToAnalysisWav } from '../audio/analysisAudio';
import { summarize } from '../music/summary';
import { fileUrl, invoke } from '../platform/tauri';
import { probeMedia, type Placement, AUDIO_ACCEPT } from '../library/importTrack';
import type { CreatedSketch, SketchDetail, SketchLibrary } from '../library/types';
import type { IncomingAudio, MidiSession, MidiSnapshot } from './types';
import { music } from './native';
export { AUDIO_ACCEPT };
export const sessions = {
  list: () => invoke<MidiSession[]>('list_midi_sessions'),
  create: (sourceId: string, midi: Uint8Array, snapshot: MidiSnapshot, destination: Record<string, unknown>) =>
    invoke<MidiSession>('create_midi_session', { args: { sourceId, midi: Array.from(midi), snapshot, destination } }),
  bytes: async (id: string) => new Uint8Array(await invoke<number[]>('midi_session_bytes', { id })),
  status: (id: string, status: 'pending' | 'cancelled' | 'archived') => invoke<MidiSession>('set_midi_session_status', { id, status }),
};
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
/** Reserve → copy unchanged media → derive waveform → atomic completion. Never transcribe. */
export async function importSessionAudio(library: SketchLibrary, session: MidiSession, input: File | IncomingAudio, place: Placement, metadata: Record<string, unknown> = {}): Promise<SketchDetail> {
  const native = !(input instanceof File);
  if (!input.size || input.size > MAX_AUDIO_BYTES) throw new Error('Choose a nonempty audio file smaller than 512 MB.');
  const extension = native ? input.extension : /\.([a-z0-9]{1,5})$/i.exec(input.name)?.[1]?.toLowerCase();
  const mimes: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' };
  if (!extension || !(extension in mimes)) throw new Error('Unsupported audio format. Use WAV, MP3, M4A, AAC, AIFF, CAF, FLAC or Ogg.');
  const probe = native ? { durationMs: input.durationMs } : await probeMedia(input);
  if (!probe.durationMs || probe.durationMs <= 0) throw new Error('The file could not be decoded as audio.');
  const created = await invoke<CreatedSketch>('begin_midi_import', { args: { sessionId: session.id, mediaExtension: extension, mediaMime: mimes[extension], ...place } });
  try {
    let durationMs = probe.durationMs;
    if (native) {
      const copied = await music.copyIncoming(input.id, created.mediaPath, created.analysisPath);
      durationMs = copied.durationMs;
    } else {
      for (let i = 0; i < input.size; i += 4 * 1024 * 1024) {
        await library.writeFile(created.id, 'media-chunk', new Uint8Array(await input.slice(i, i + 4 * 1024 * 1024).arrayBuffer()));
      }
      const analysis = await decodeMediaToAnalysisWav(fileUrl(created.mediaPath));
      await library.writeFile(created.id, 'analysis', analysis.wav);
      durationMs = analysis.durationMs;
    }
    const detail = await invoke<SketchDetail>('complete_midi_import', { args: { sessionId: session.id, durationMs,
      originalFilename: input.name, summary: summarize(session.snapshot.notes), metadata } });
    if (native) await music.acknowledge(input.id).catch(() => {});
    return detail;
  } catch (error) {
    await invoke('abort_midi_import', { id: session.id }).catch(() => {});
    throw error;
  }
}
