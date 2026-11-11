// Copies the Basic Pitch TF.js model out of node_modules into public/ so it is
// bundled with the app and loaded from the local origin (no network needed).
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@spotify', 'basic-pitch', 'model');
const dest = join(root, 'public', 'models', 'basic-pitch');

if (!existsSync(src)) {
  console.warn(`[copy-model] ${src} not found; skipping (run npm install first)`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const file of ['model.json', 'group1-shard1of1.bin']) {
  cpSync(join(src, file), join(dest, file));
}
console.log(`[copy-model] Basic Pitch model copied to ${dest}`);
