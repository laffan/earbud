import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import wasmPath from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import wasmModule from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import { decodeDettato, KEYS } from './dettatoDecode';

const RATE = 16000;
const HOP = 320;
const WINDOW = 32000;
const STEP = WINDOW / 2;

self.onmessage = async ({ data }: MessageEvent<{ samples: Float32Array; base: string }>) => {
  try {
    const { samples, base } = data;
    env.wasm.numThreads = 1;
    env.wasm.wasmPaths = { wasm: new URL(wasmPath, base).href, mjs: new URL(wasmModule, base).href };
    const model = new URL('models/dettato/transcriber.onnx', base).href;
    const session = await InferenceSession.create(model, { executionProviders: ['wasm'], enableCpuMemArena: false });
    const frames = Math.ceil(samples.length / HOP);
    const maps = Array.from({ length: 6 }, () => new Float32Array(frames * KEYS));
    const weights = new Float32Array(frames);
    const windowFrames = WINDOW / HOP;
    const taper = Array.from({length: windowFrames}, (_, i) => Math.sin(Math.PI * (i + 1) / (windowFrames + 1)) ** 2);
    for (let start = -STEP; start < samples.length; start += STEP) {
      const input = new Float32Array(WINDOW);
      input.set(samples.subarray(Math.max(0, start), Math.min(samples.length, start + WINDOW)), Math.max(0, -start));
      const { maps: result } = await session.run({ audio: new Tensor('float32', input, [1, WINDOW]) });
      const plane = result.data as Float32Array;
      for (let t = 0; t < windowFrames; t++) {
        const frame = start / HOP + t;
        if (frame < 0 || frame >= frames) continue;
        weights[frame] += taper[t];
        for (let head = 0; head < maps.length; head++) {
          const from = (head * windowFrames + t) * KEYS;
          for (let k = 0; k < KEYS; k++) maps[head][frame * KEYS + k] += plane[from + k] * taper[t];
        }
      }
      result.dispose();
      self.postMessage({ progress: Math.min(1, (start + STEP) / samples.length) });
    }
    for (const map of maps) {
      for (let i = 0; i < map.length; i++) map[i] /= weights[Math.floor(i / KEYS)];
    }
    self.postMessage({ notes: decodeDettato(maps, samples.length / RATE) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
