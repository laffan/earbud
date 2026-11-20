import { loadAnalysisSamples } from '../audio/analysisAudio';
import { TranscriptionAbortedError, type PianoNote, type TranscribeOptions, type TranscriptionEngine } from './types';

export class MobileDettatoEngine implements TranscriptionEngine {
  readonly id = 'dettato-transcriber';
  readonly version = '2.0.0';
  readonly params = { sampleRate: 16000, windowSeconds: 2, strideSeconds: 1, velocity: 80 };

  async transcribe(path: string, { signal, onProgress }: TranscribeOptions = {}): Promise<PianoNote[]> {
    if (signal?.aborted) throw new TranscriptionAbortedError();
    const samples = await loadAnalysisSamples(path, this.params.sampleRate);
    if (signal?.aborted) throw new TranscriptionAbortedError();
    if (!samples.length) return [];
    const worker = new Worker(new URL('./dettatoMobile.worker.ts', import.meta.url), { type: 'module' });
    let cancel: (() => void) | undefined;
    try {
      return await new Promise<PianoNote[]>((resolve, reject) => {
        cancel = () => reject(new TranscriptionAbortedError());
        signal?.addEventListener('abort', cancel, { once: true });
        worker.onerror = event => reject(new Error(event.message || 'Dettato worker stopped'));
        worker.onmessage = ({ data }) => {
          if (data.error) reject(new Error(data.error));
          else if (data.notes) resolve(data.notes);
          else onProgress?.(data.progress);
        };
        worker.postMessage({ samples, base: document.baseURI }, [samples.buffer]);
      });
    } finally {
      worker.terminate();
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }
}
