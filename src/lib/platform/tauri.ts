/**
 * Thin platform layer. Everything that differs between "running inside
 * Tauri" and "running in a plain browser during development" is decided here.
 */
import { convertFileSrc, invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  return tauriInvoke<T>(cmd, args, options);
}

/** URL the webview can load for a file on disk (or a blob URL in dev). */
export function fileUrl(path: string): string {
  if (/^(blob:|https?:|data:|asset:)/.test(path)) return path;
  return convertFileSrc(path);
}

export function isIOSLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Normalise errors from `invoke` (strings or `{ message, code }`). */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}
