/** WatchLinkClient backed by the Rust commands and the iOS `watch-link` plugin. */
import { Channel } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '../platform/tauri';
import type {
  ImportReport,
  NativeStartArgs,
  NativeWatchEvent,
  NativeWatchStatus,
  WatchLinkClient,
  WatchLinkEvent,
  WatchLinkStatus,
} from './types';

export class TauriWatchLink implements WatchLinkClient {
  status() {
    return invoke<WatchLinkStatus>('watch_link_status');
  }
  setEnabled(enabled: boolean) {
    return invoke<WatchLinkStatus>('watch_link_set_enabled', { enabled });
  }
  setName(name: string) {
    return invoke<WatchLinkStatus>('watch_link_set_name', { name });
  }
  beginPairing() {
    return invoke<WatchLinkStatus>('watch_link_begin_pairing');
  }
  endPairing() {
    return invoke<WatchLinkStatus>('watch_link_end_pairing');
  }
  recordPairing(watchName: string, via: string) {
    return invoke<WatchLinkStatus>('watch_link_record_pairing', { watchName, via });
  }
  reset() {
    return invoke<WatchLinkStatus>('watch_link_reset');
  }
  resume() {
    return invoke<WatchLinkStatus>('watch_link_resume');
  }
  importInbox() {
    return invoke<ImportReport>('import_watch_inbox');
  }
  async listen(handler: (event: WatchLinkEvent) => void) {
    return listen<WatchLinkEvent>('watch-link', (event) => handler(event.payload));
  }

  async nativeAvailable() {
    try {
      return await invoke<boolean>('plugin:watch-link|available');
    } catch {
      return false;
    }
  }
  startNative(args: NativeStartArgs, onEvent: (event: NativeWatchEvent) => void) {
    const events = new Channel<NativeWatchEvent>();
    events.onmessage = onEvent;
    return invoke<NativeWatchStatus>('plugin:watch-link|start', { ...args, events });
  }
  stopNative() {
    return invoke<NativeWatchStatus>('plugin:watch-link|stop');
  }
  nativeBeginPairing(code: string, durationMs: number) {
    return invoke<NativeWatchStatus>('plugin:watch-link|begin_pairing', { code, durationMs });
  }
  nativeEndPairing() {
    return invoke<NativeWatchStatus>('plugin:watch-link|end_pairing');
  }
  nativeStatus() {
    return invoke<NativeWatchStatus>('plugin:watch-link|status');
  }
}
