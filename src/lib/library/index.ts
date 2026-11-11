import { isTauri } from '../platform/tauri';
import { MemoryLibrary } from './memoryLibrary';
import { TauriLibrary } from './tauriLibrary';
import type { SketchLibrary } from './types';

export * from './types';

let instance: SketchLibrary | null = null;

/** The app's Sketch Library: SQLite via Rust in Tauri, in-memory in a browser. */
export function getLibrary(): SketchLibrary {
  instance ??= isTauri() ? new TauriLibrary() : new MemoryLibrary();
  return instance;
}
