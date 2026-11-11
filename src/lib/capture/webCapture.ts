/**
 * Desktop/browser capture backend: getUserMedia + MediaRecorder.
 *
 * Audio and video come from one MediaStream and are muxed by MediaRecorder,
 * so they share a clock. Chunks are streamed to the sketch directory every
 * second, so a crash loses at most the last second. Audio processing (echo
 * cancellation, noise suppression, AGC) is disabled: it is designed for
 * speech and damages piano sound.
 */
import type {
  ActiveRecording,
  CaptureEngine,
  CaptureEvent,
  CapturePermissions,
  CaptureSettings,
  PermissionState,
  RecordingResult,
  RecordingTarget,
} from './types';

const VIDEO_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const AUDIO_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

function pickType(candidates: string[]): string {
  if (typeof MediaRecorder === 'undefined') return candidates[candidates.length - 1];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

function extensionFor(mime: string, video: boolean): string {
  if (mime.startsWith('video/mp4')) return 'mp4';
  if (mime.startsWith('audio/mp4')) return 'm4a';
  if (mime.includes('webm')) return video ? 'webm' : 'weba';
  return video ? 'mp4' : 'm4a';
}

async function queryPermission(name: 'camera' | 'microphone'): Promise<PermissionState> {
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
}

export class WebCaptureEngine implements CaptureEngine {
  readonly id = 'web-mediarecorder';
  readonly nativePreview = false;

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  mediaFormat(settings: CaptureSettings) {
    const video = settings.camera !== 'none';
    const mime = pickType(video ? VIDEO_TYPES : AUDIO_TYPES);
    return { extension: extensionFor(mime, video), mime: mime || (video ? 'video/mp4' : 'audio/mp4') };
  }

  async checkPermissions(): Promise<CapturePermissions> {
    const [camera, microphone] = await Promise.all([queryPermission('camera'), queryPermission('microphone')]);
    return { camera, microphone };
  }

  async requestPermissions(settings: CaptureSettings): Promise<CapturePermissions> {
    // Permission prompts are attached to getUserMedia itself; start() asks.
    return this.checkPermissions().then((p) => (settings.camera === 'none' ? { ...p, camera: 'granted' } : p));
  }

  async start(
    target: RecordingTarget,
    settings: CaptureSettings,
    onEvent: (event: CaptureEvent) => void,
  ): Promise<ActiveRecording> {
    const wantsVideo = settings.camera !== 'none';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: wantsVideo
        ? {
            facingMode: settings.camera === 'front' ? 'user' : 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : false,
    });
    const hasVideo = stream.getVideoTracks().length > 0;
    const { mime } = this.mediaFormat(settings);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 160_000,
        videoBitsPerSecond: 2_500_000,
      });
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      throw error;
    }

    // Serialize chunk writes so the file is assembled in order.
    let writes: Promise<void> = Promise.resolve();
    let writeError: unknown = null;
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      const blob = event.data;
      writes = writes.then(async () => {
        try {
          await target.writeChunk(new Uint8Array(await blob.arrayBuffer()));
        } catch (error) {
          writeError = error;
        }
      });
    };

    const meter = createLevelMeter(stream);
    const startedAt = performance.now();
    const levelTimer = window.setInterval(() => {
      const level = meter?.read();
      onEvent({
        type: 'level',
        averageDb: level?.averageDb ?? -160,
        peakDb: level?.peakDb ?? -160,
        elapsedMs: performance.now() - startedAt,
      });
    }, 100);

    let wakeLock: { release(): Promise<void> } | null = null;
    try {
      wakeLock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } })
        .wakeLock?.request('screen') ?? null;
    } catch {
      wakeLock = null;
    }

    const cleanup = () => {
      window.clearInterval(levelTimer);
      meter?.close();
      stream.getTracks().forEach((t) => t.stop());
      void wakeLock?.release().catch(() => {});
    };

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    // A track ending on its own (device unplugged, permission revoked).
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (recorder.state !== 'inactive') {
          onEvent({ type: 'interrupted', reason: `${track.kind} ended` });
        }
      };
    }

    recorder.onerror = (event) => {
      const message = (event as unknown as { error?: Error }).error?.message ?? 'Recorder error';
      onEvent({ type: 'error', message });
    };

    recorder.start(1000);
    const settingsOfVideo = stream.getVideoTracks()[0]?.getSettings();

    return {
      hasVideo,
      previewStream: stream,
      stop: async (): Promise<RecordingResult> => {
        const durationMs = performance.now() - startedAt;
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        await writes;
        cleanup();
        return {
          ok: !writeError,
          durationMs,
          hasVideo,
          width: settingsOfVideo?.width,
          height: settingsOfVideo?.height,
          message: writeError ? String(writeError) : undefined,
        };
      },
    };
  }
}

function createLevelMeter(stream: MediaStream) {
  try {
    const Ctx: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      read() {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        let peak = 0;
        for (const x of buffer) {
          sum += x * x;
          peak = Math.max(peak, Math.abs(x));
        }
        const rms = Math.sqrt(sum / buffer.length);
        const db = (v: number) => (v > 0 ? Math.max(-160, 20 * Math.log10(v)) : -160);
        return { averageDb: db(rms), peakDb: db(peak) };
      },
      close() {
        source.disconnect();
        void ctx.close();
      },
    };
  } catch {
    return null;
  }
}
