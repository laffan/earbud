import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Set by `tauri ios dev` / `tauri android dev` so a physical device can reach
// the dev server over the local network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  // Keep Rust errors visible when running under `tauri dev`.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/plugins/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  worker: { format: 'es' },
  build: {
    // WKWebView on iOS 15 / Safari 15 is the oldest engine we target.
    target: ['es2021', 'safari15'],
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 2500,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
