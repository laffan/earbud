/// <reference lib="webworker" />
/**
 * Runs Basic Pitch off the main thread so recording, playback and scrolling
 * stay responsive while a sketch is transcribed.
 */
import {
  loadModel,
  notesFromModelOutput,
  runModel,
  selectBackend,
  type BasicPitchParams,
  type ModelArtifacts,
} from './basicPitchCore';
import type { GraphModel } from '@tensorflow/tfjs';

export type WorkerRequest =
  | { type: 'init'; model: ModelArtifacts; backends: string[] }
  | { type: 'transcribe'; id: number; samples: Float32Array; params: BasicPitchParams };

export type WorkerResponse =
  | { type: 'ready'; backend: string }
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'result'; id: number; notes: import('./types').PianoNote[] }
  | { type: 'error'; id: number | null; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let model: GraphModel | null = null;

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      const backend = await selectBackend(message.backends);
      model = await loadModel(message.model);
      scope.postMessage({ type: 'ready', backend } satisfies WorkerResponse);
    } else if (message.type === 'transcribe') {
      if (!model) throw new Error('Model not loaded');
      const output = await runModel(model, message.samples, (fraction) => {
        scope.postMessage({ type: 'progress', id: message.id, fraction } satisfies WorkerResponse);
      });
      const notes = notesFromModelOutput(output, message.params);
      scope.postMessage({ type: 'result', id: message.id, notes } satisfies WorkerResponse);
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: message.type === 'transcribe' ? message.id : null,
      message: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
};
