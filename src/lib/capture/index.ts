import { isTauri } from '../platform/tauri';
import { NativeCaptureEngine, nativeCapabilities, type NativeCapabilities } from './nativeCapture';
import { WebCaptureEngine } from './webCapture';
import type { CaptureEngine } from './types';

export * from './types';
export { shareFiles } from './nativeCapture';

export interface PlatformCapabilities extends NativeCapabilities {
  tauri: boolean;
}

/** What this device can do natively (all false in a plain browser). */
export async function detectCapabilities(): Promise<PlatformCapabilities> {
  if (isTauri()) {
    try {
      return { ...(await nativeCapabilities()), tauri: true };
    } catch {
      // Plugin missing: fall through to web-only capabilities.
    }
  }
  return {
    tauri: isTauri(),
    nativeCapture: false,
    nativeAudioExtraction: false,
    nativeShare: false,
    platform: 'web',
  };
}

/** Pick the best capture backend for this platform. */
export function createCaptureEngine(caps: PlatformCapabilities): CaptureEngine | null {
  if (caps.nativeCapture) return new NativeCaptureEngine();
  if (WebCaptureEngine.isSupported()) return new WebCaptureEngine();
  return null;
}
