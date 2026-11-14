/// <reference lib="webworker" />
/** Runs `stretchChannels` off the main thread (slowed playback). */
import { stretchChannels } from './stretch';

interface Request {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  rate: number;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, channels, sampleRate, rate } = event.data;
  try {
    const out = stretchChannels(channels, sampleRate, rate);
    (self as unknown as Worker).postMessage({ id, channels: out }, out.map((c) => c.buffer));
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
