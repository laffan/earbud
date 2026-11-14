/**
 * Where the take's video element gets its picture from, with a fallback:
 * the original file URL, then an in-memory copy (some WebKit builds cannot
 * stream or seek media from a custom URL scheme but play a blob fine). The
 * sound never comes from here: it plays through the audio engine.
 */
import { fileUrl } from '../platform/tauri';

/** Files up to this size may be copied into memory to play. */
const BLOB_FALLBACK_LIMIT = 200 * 1024 * 1024;

export class TakeSource {
  sources = $state<string[]>([]);
  index = $state(0);
  /** Shown under the video when it cannot be shown. */
  notice = $state<string | null>(null);
  private blobUrl: string | null = null;
  private disposed = false;

  constructor(
    private readonly mediaPath: string | null,
    private readonly log: (message: string) => void,
  ) {
    if (mediaPath) this.sources = [fileUrl(mediaPath)];
  }

  get src(): string | undefined {
    return this.sources[this.index];
  }

  /**
   * Switch from the original file URL to an in-memory copy of the take, for
   * files that comfortably fit in memory. Returns whether the source changed.
   */
  async loadIntoMemory(): Promise<boolean> {
    if (!this.mediaPath || this.blobUrl) return false;
    const original = fileUrl(this.mediaPath);
    if (this.sources[this.index] !== original || original.startsWith('blob:')) return false;
    try {
      const probe = await fetch(original, { headers: { Range: 'bytes=0-0' } });
      const total =
        probe.status === 206 ? probe.headers.get('content-range')?.split('/')[1] : probe.headers.get('content-length');
      void probe.body?.cancel().catch(() => {});
      const size = Number(total ?? NaN);
      const response = size < BLOB_FALLBACK_LIMIT ? await fetch(original) : null;
      if (!response?.ok || this.blobUrl || this.disposed) return false;
      this.blobUrl = URL.createObjectURL(await response.blob());
      this.sources = [...this.sources, this.blobUrl];
      this.index = this.sources.length - 1;
      return true;
    } catch {
      return false;
    }
  }

  /** The current source failed to load: try the in-memory copy. */
  async failed(error: MediaError | null) {
    if (!this.mediaPath) return;
    this.log(`video source ${this.index} failed (code ${error?.code ?? '?'} ${error?.message ?? ''}); trying the next one`);
    if (await this.loadIntoMemory()) return;
    this.notice = 'The video cannot be shown on this device. The recording still plays.';
  }

  dispose() {
    this.disposed = true;
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = null;
  }
}
