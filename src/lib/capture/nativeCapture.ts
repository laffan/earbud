/** iOS capture backend: AVFoundation through `tauri-plugin-capture`. */
import { Channel } from '@tauri-apps/api/core';
import { invoke } from '../platform/tauri';
import type {
  ActiveRecording,
  CaptureDiagnostics,
  CaptureEngine,
  CaptureEvent,
  CapturePermissions,
  CaptureSettings,
  RecordingResult,
  RecordingTarget,
} from './types';

interface StartResponse {
  path: string;
  hasVideo: boolean;
}

export class NativeCaptureEngine implements CaptureEngine {
  readonly id = 'ios-avfoundation';
  readonly nativePreview = true;

  mediaFormat() {
    // AVCaptureMovieFileOutput always writes QuickTime movies.
    return { extension: 'mov', mime: 'video/quicktime' };
  }

  checkPermissions(): Promise<CapturePermissions> {
    return invoke<CapturePermissions>('plugin:capture|check_permissions');
  }

  requestPermissions(): Promise<CapturePermissions> {
    return invoke<CapturePermissions>('plugin:capture|request_permissions');
  }

  async openSettings(): Promise<void> {
    await invoke('plugin:capture|open_app_settings');
  }

  async reset(): Promise<void> {
    await invoke('plugin:capture|reset_capture');
  }

  diagnostics(): Promise<CaptureDiagnostics> {
    return invoke<CaptureDiagnostics>('plugin:capture|get_diagnostics');
  }

  async start(
    target: RecordingTarget,
    settings: CaptureSettings,
    onEvent: (event: CaptureEvent) => void,
  ): Promise<ActiveRecording> {
    const events = new Channel<CaptureEvent>();
    events.onmessage = onEvent;
    const started = await invoke<StartResponse>('plugin:capture|start_recording', {
      outputPath: target.mediaPath,
      camera: settings.camera,
      lens: settings.lens,
      rawAudio: settings.rawAudio,
      events,
    });
    return {
      hasVideo: started.hasVideo,
      stop: () => invoke<RecordingResult>('plugin:capture|stop_recording'),
    };
  }

  async exportAudio(mediaPath: string, outputPath: string): Promise<void> {
    await invoke('plugin:capture|export_audio', { inputPath: mediaPath, outputPath });
  }

  async extractAnalysisAudio(mediaPath: string, analysisPath: string) {
    const result = await invoke<{ durationMs: number }>('plugin:capture|extract_analysis_audio', {
      inputPath: mediaPath,
      outputPath: analysisPath,
      sampleRate: 22050,
    });
    return { durationMs: Math.round(result.durationMs) };
  }
}

export interface NativeCapabilities {
  nativeCapture: boolean;
  nativeAudioExtraction: boolean;
  nativeShare: boolean;
  nativeAudioExport?: boolean;
  platform: string;
}

export function nativeCapabilities(): Promise<NativeCapabilities> {
  return invoke<NativeCapabilities>('plugin:capture|capabilities');
}

export function shareFiles(paths: string[]): Promise<{ completed: boolean; activity: string }> {
  return invoke('plugin:capture|share_files', { paths });
}
