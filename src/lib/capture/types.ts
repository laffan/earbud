/**
 * Capture Engine contract. Implementations:
 *  - `NativeCaptureEngine`: AVFoundation via `tauri-plugin-capture` (iOS).
 *  - `WebCaptureEngine`: getUserMedia + MediaRecorder (desktop / browser).
 *
 * Both write the original recording directly into the sketch directory
 * reserved by the Sketch Library, and both work without a network.
 */
import type { CreatedSketch } from '../library/types';

export type CameraChoice = 'back' | 'front' | 'none';
export type LensChoice = 'wide' | 'ultraWide';

export interface CaptureSettings {
  camera: CameraChoice;
  lens: LensChoice;
  /** Ask the OS for an unprocessed microphone signal where supported. */
  rawAudio: boolean;
}

export interface RecordingResult {
  /** False if the recording ended with an error; the file may still be usable. */
  ok: boolean;
  durationMs: number;
  hasVideo: boolean;
  width?: number;
  height?: number;
  message?: string;
}

export type CaptureEvent =
  | { type: 'level'; averageDb: number; peakDb: number; elapsedMs: number }
  | { type: 'interrupted'; reason: number | string }
  | { type: 'error'; message: string }
  | ({ type: 'finished' } & RecordingResult);

export type PermissionState = 'granted' | 'prompt' | 'denied';

export interface CapturePermissions {
  camera: PermissionState;
  microphone: PermissionState;
}

export interface ActiveRecording {
  readonly hasVideo: boolean;
  /** Live preview for web backends; native backends draw their own. */
  readonly previewStream?: MediaStream;
  stop(): Promise<RecordingResult>;
}

/** Where a backend writes the recording. */
export interface RecordingTarget extends CreatedSketch {
  /** Append a chunk of the recording (web backends stream to disk). */
  writeChunk(bytes: Uint8Array): Promise<void>;
}

export interface CaptureEngine {
  readonly id: string;
  /** The preview is rendered natively behind a transparent webview. */
  readonly nativePreview: boolean;
  /** Container the backend will produce for these settings. */
  mediaFormat(settings: CaptureSettings): { extension: string; mime: string };
  checkPermissions(settings: CaptureSettings): Promise<CapturePermissions>;
  requestPermissions(settings: CaptureSettings): Promise<CapturePermissions>;
  openSettings?(): Promise<void>;
  start(
    target: RecordingTarget,
    settings: CaptureSettings,
    onEvent: (event: CaptureEvent) => void,
  ): Promise<ActiveRecording>;
  /**
   * Write the 22.05 kHz mono analysis WAV for a recording, natively.
   * Backends without native support omit this; the pipeline then decodes
   * the recording with Web Audio instead.
   */
  extractAnalysisAudio?(mediaPath: string, analysisPath: string): Promise<{ durationMs: number }>;
}
