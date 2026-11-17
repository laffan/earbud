/**
 * A steel-string acoustic guitar for chord previews: recorded notes (one
 * every major third, E2–A♭5; see public/sounds/guitar/README.md), each
 * chord note played from the nearest recording, resampled by at most two
 * semitones, strummed from the lowest string up.
 *
 * The recordings are decoded once (the buffers belong to no context) and
 * shared by every context that plays them. Until they are ready, chords
 * fall back to the piano voice.
 */
import { scheduleSampleNote, type PitchedSample, type SampleVoice } from '../samples/render';

/** The recorded notes (MIDI). */
export const GUITAR_SAMPLE_NOTES = [40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80];
/** Between strings in a strum (seconds). */
export const STRUM = 0.028;

let zones: PitchedSample[] | null = null;
let loading: Promise<PitchedSample[]> | null = null;

function url(note: number): string {
  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return `${base.replace(/\/?$/, '/')}sounds/guitar/${note}.mp3`;
}

function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    try {
      const result = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined;
      result?.then?.(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

/** Leading silence left by the encoder is cut, so a strum is tight. */
function trimLead(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  let first = 0;
  while (first < data.length && Math.abs(data[first]) < peak * 0.02) first++;
  first = Math.max(0, first - Math.round(buffer.sampleRate * 0.002));
  if (first === 0) return buffer;
  const out = ctx.createBuffer(1, data.length - first, buffer.sampleRate);
  out.copyToChannel(data.slice(first), 0);
  return out;
}

/** Load the recordings (once). `ctx` only decodes them. */
export function loadGuitar(ctx: BaseAudioContext): Promise<PitchedSample[]> {
  if (zones) return Promise.resolve(zones);
  loading ??= Promise.all(
    GUITAR_SAMPLE_NOTES.map(async (note) => {
      const response = await fetch(url(note));
      if (!response.ok) throw new Error(`guitar sample ${note}: ${response.status}`);
      return { buffer: trimLead(ctx, await decode(ctx, await response.arrayBuffer())), root: note };
    }),
  ).then(
    (loaded) => (zones = loaded),
    (error) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The recordings, if loaded. */
export function guitarZones(): PitchedSample[] | null {
  return zones;
}

/** The recording a note is played from: the nearest (the lower one on a tie). */
export function nearestZone<T extends { root: number }>(list: readonly T[], pitch: number): T {
  let best = list[0];
  for (const zone of list) if (Math.abs(zone.root - pitch) < Math.abs(best.root - pitch)) best = zone;
  return best;
}

/** A chord strummed from the lowest note up, starting at `when`. */
export function strumGuitar(
  ctx: BaseAudioContext,
  destination: AudioNode,
  list: readonly PitchedSample[],
  pitches: number[],
  when: number,
  { velocity = 85, length = 2.2, spread = STRUM }: { velocity?: number; length?: number; spread?: number } = {},
): SampleVoice[] {
  return [...pitches]
    .sort((a, b) => a - b)
    .map((pitch, i) => scheduleSampleNote(ctx, destination, nearestZone(list, pitch), pitch, velocity, when + i * spread, length, 0.25));
}
