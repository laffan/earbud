/**
 * Cutting a passage out of a recording for the sample library: the samples
 * of [from, to) of the take's decoded sound, mixed to mono and written as a
 * 16-bit WAV, with first settings (its root note, when it has a steady
 * pitch, so it can play notes in tune).
 */
import { detectPitch } from '../audio/pitch';
import { encodeWav16 } from '../audio/wav';
import { DEFAULT_SAMPLE_SETTINGS, toMono, type SampleSettings } from './settings';

export interface CutSample {
  wav: Uint8Array;
  durationMs: number;
  settings: SampleSettings;
}

/** Channels of a sound (an AudioBuffer or plain arrays). */
export interface SoundData {
  sampleRate: number;
  channels: Float32Array[];
}

export function bufferData(buffer: AudioBuffer): SoundData {
  return {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
  };
}

/** [from, to) seconds of a sound, mono. */
export function cutMono(sound: SoundData, from: number, to: number): Float32Array<ArrayBuffer> {
  const length = sound.channels[0]?.length ?? 0;
  const a = Math.max(0, Math.min(length, Math.floor(from * sound.sampleRate)));
  const b = Math.max(a, Math.min(length, Math.round(to * sound.sampleRate)));
  const mono = toMono(sound.channels.map((c) => c.subarray(a, b)));
  return new Float32Array(mono);
}

/** First settings for a sound: as recorded, with the root note it was found to sound at. */
export function initialSettings(samples: Float32Array, sampleRate: number): SampleSettings {
  const pitch = detectPitch(samples, sampleRate);
  return {
    ...DEFAULT_SAMPLE_SETTINGS,
    rootPitch: pitch ? Math.min(108, Math.max(21, pitch.note)) : null,
    fineCents: pitch ? pitch.cents : 0,
    rootSource: pitch ? 'detected' : null,
  };
}

/** The passage [from, to) (seconds of the sound) as a sample to store. */
export function cutSample(sound: SoundData, from: number, to: number): CutSample {
  const mono = cutMono(sound, from, to);
  if (mono.length < 2) throw new Error('the selection has no sound');
  return {
    wav: encodeWav16([mono], sound.sampleRate),
    durationMs: Math.max(1, Math.round((mono.length / sound.sampleRate) * 1000)),
    settings: initialSettings(mono, sound.sampleRate),
  };
}
