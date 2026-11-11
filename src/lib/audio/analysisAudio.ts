/**
 * Loading and producing the derived analysis audio (22.05 kHz mono WAV).
 * The original recording is only ever read.
 */
import { fileUrl } from '../platform/tauri';
import { decodeWav, downmix, encodeWav16 } from './wav';
import { resample } from './resample';

export const ANALYSIS_SAMPLE_RATE = 22050;

/** Read a WAV from disk and return mono samples at `targetRate`. */
export async function loadAnalysisSamples(
  path: string,
  targetRate = ANALYSIS_SAMPLE_RATE,
): Promise<Float32Array> {
  const response = await fetch(fileUrl(path));
  if (!response.ok) throw new Error(`Could not read analysis audio (${response.status})`);
  const pcm = decodeWav(await response.arrayBuffer());
  return resample(downmix(pcm.channels), pcm.sampleRate, targetRate);
}

/**
 * Browser fallback for platforms without a native extractor: decode the
 * recording's audio track with Web Audio and encode it as 16-bit mono WAV.
 */
export async function decodeMediaToAnalysisWav(mediaUrl: string): Promise<{
  wav: Uint8Array;
  durationMs: number;
}> {
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`Could not read recording (${response.status})`);
  const bytes = await response.arrayBuffer();
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  // An OfflineAudioContext would avoid touching the audio hardware, but its
  // decodeAudioData is missing on older WebKit; a short-lived context is fine.
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(bytes);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    const mono = resample(downmix(channels), audio.sampleRate, ANALYSIS_SAMPLE_RATE);
    return {
      wav: encodeWav16([mono], ANALYSIS_SAMPLE_RATE),
      durationMs: Math.round(audio.duration * 1000),
    };
  } finally {
    void ctx.close();
  }
}

/**
 * Decode a recording's audio at its own sample rate (up to two channels) and
 * encode it as 16-bit WAV. Used to export the take's sound where no native
 * exporter exists.
 */
export async function decodeMediaToWav(mediaUrl: string): Promise<Uint8Array> {
  const response = await fetch(mediaUrl);
  if (!response.ok) throw new Error(`Could not read recording (${response.status})`);
  const bytes = await response.arrayBuffer();
  const Ctx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const audio = await ctx.decodeAudioData(bytes);
    const channels = Array.from({ length: Math.min(2, audio.numberOfChannels) }, (_, c) => audio.getChannelData(c));
    return encodeWav16(channels, audio.sampleRate);
  } finally {
    void ctx.close();
  }
}
