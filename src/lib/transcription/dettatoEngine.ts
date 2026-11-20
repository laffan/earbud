import { fileUrl } from '../platform/tauri';
import { TranscriptionAbortedError, type PianoNote, type TranscriptionEngine, type TranscribeOptions } from './types';

export class DettatoEngine implements TranscriptionEngine {
  readonly id = 'dettato';
  readonly version = '2.0.0';
  readonly params = { tracks: 'all pitched', sampleRate: 22050 } as const;

  async transcribe(path: string, { signal, onProgress }: TranscribeOptions = {}): Promise<PianoNote[]> {
    try {
      const audio = await fetch(fileUrl(path), { signal });
      if (!audio.ok) throw new Error(`Could not read analysis audio (${audio.status})`);
      const body = await audio.blob();
      const response = await fetch('http://127.0.0.1:17382/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body, signal,
      }).catch(() => { throw new Error('Could not reach Dettato. Start scripts/dettato-server.py on this computer.'); });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Dettato failed (${response.status})`);
      if (signal?.aborted) throw new TranscriptionAbortedError();
      onProgress?.(1);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new TranscriptionAbortedError();
      throw error;
    }
  }
}
