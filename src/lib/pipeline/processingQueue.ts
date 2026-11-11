/**
 * Background processing pipeline: recording → analysis audio → notes →
 * chords/summary → MIDI. Runs one sketch at a time, never blocks capture,
 * and never touches the original recording. Any failure only marks the
 * transcription as failed; the sketch itself is already safely saved.
 */
import { decodeMediaToAnalysisWav } from '../audio/analysisAudio';
import type { CaptureEngine } from '../capture/types';
import { analysisPathFor, type Sketch, type SketchLibrary } from '../library/types';
import { notesToMidi } from '../music/midi';
import { summarize } from '../music/summary';
import { fileUrl, errorMessage } from '../platform/tauri';
import { TranscriptionAbortedError, type TranscriptionEngine } from '../transcription/types';

export type JobStage = 'queued' | 'audio' | 'transcribing' | 'saving';

export interface JobProgress {
  stage: JobStage;
  /** 0–1 within the transcribing stage. */
  fraction: number;
}

export interface ProcessingQueueOptions {
  library: SketchLibrary;
  capture: () => CaptureEngine | null;
  engine: () => TranscriptionEngine;
  onProgress: (id: string, progress: JobProgress | null) => void;
  onSketchChanged: (sketch: Sketch) => void;
}

export class ProcessingQueue {
  private queue: string[] = [];
  private running: string | null = null;
  private abort: AbortController | null = null;
  private paused = false;

  constructor(private options: ProcessingQueueOptions) {}

  /** Queue a sketch for (re-)transcription. No-op if already queued. */
  enqueue(id: string) {
    if (this.running === id || this.queue.includes(id)) return;
    this.queue.push(id);
    this.options.onProgress(id, { stage: 'queued', fraction: 0 });
    void this.pump();
  }

  /** Cancel a queued or running job. */
  cancel(id: string) {
    this.queue = this.queue.filter((q) => q !== id);
    if (this.running === id) this.abort?.abort();
    else this.options.onProgress(id, null);
  }

  /** Hold off starting new jobs (e.g. while recording). */
  setPaused(paused: boolean) {
    this.paused = paused;
    if (!paused) void this.pump();
  }

  isBusy(id: string): boolean {
    return this.running === id || this.queue.includes(id);
  }

  private async pump() {
    if (this.running || this.paused) return;
    const id = this.queue.shift();
    if (!id) return;
    this.running = id;
    this.abort = new AbortController();
    try {
      await this.process(id, this.abort.signal);
    } finally {
      this.running = null;
      this.abort = null;
      this.options.onProgress(id, null);
      void this.pump();
    }
  }

  private async process(id: string, signal: AbortSignal) {
    const { library, onProgress, onSketchChanged } = this.options;
    let sketch: Sketch;
    try {
      sketch = await library.get(id);
    } catch {
      return; // deleted while queued
    }
    if (sketch.status !== 'saved' || !sketch.mediaPath) return;

    try {
      onSketchChanged(await library.setTranscriptionStatus(id, 'running'));

      // 1. Analysis audio (derived; the recording is only read).
      let analysisPath = sketch.analysisPath;
      if (!analysisPath) {
        onProgress(id, { stage: 'audio', fraction: 0 });
        const capture = this.options.capture();
        let durationMs: number;
        if (capture?.extractAnalysisAudio && sketch.captureBackend === capture.id) {
          analysisPath = analysisPathFor(sketch.mediaPath);
          ({ durationMs } = await capture.extractAnalysisAudio(sketch.mediaPath, analysisPath));
        } else {
          const decoded = await decodeMediaToAnalysisWav(fileUrl(sketch.mediaPath));
          analysisPath = await library.writeFile(id, 'analysis', decoded.wav);
          durationMs = decoded.durationMs;
        }
        if (!sketch.durationMs && durationMs > 0) {
          onSketchChanged(await library.update({ id, durationMs }));
        }
      }
      if (signal.aborted) throw new TranscriptionAbortedError();

      // 2. Notes.
      onProgress(id, { stage: 'transcribing', fraction: 0 });
      const engine = this.options.engine();
      const notes = await engine.transcribe(analysisPath, {
        signal,
        onProgress: (fraction) => onProgress(id, { stage: 'transcribing', fraction }),
      });

      // 3. Music analysis, persistence and MIDI rendering.
      onProgress(id, { stage: 'saving', fraction: 1 });
      const detail = await library.saveTranscription({
        id,
        engine: engine.id,
        engineVersion: engine.version,
        params: { ...engine.params },
        notes,
        summary: summarize(notes),
      });
      await library.writeFile(id, 'midi', notesToMidi(notes, { title: detail.title || undefined }));
      onSketchChanged(detail);
    } catch (error) {
      if (error instanceof TranscriptionAbortedError) {
        onSketchChanged(await library.setTranscriptionStatus(id, 'pending').catch(() => sketch));
        return;
      }
      console.error(`[earbud] transcription failed for ${id}`, error);
      const updated = await library
        .setTranscriptionStatus(id, 'failed', errorMessage(error))
        .catch(() => null);
      if (updated) onSketchChanged(updated);
    }
  }
}
