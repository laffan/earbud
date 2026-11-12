/**
 * Test helper: recorded Basic Pitch activations (see
 * `src/lib/transcription/fixtures/README.md`). Each file is gzip of
 * `frames` then `onsets`, row by row, 88 little-endian uint16 per row,
 * value × 1000.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { ModelOutput } from '../transcription/basicPitchParams';

const COLUMNS = 88;

export function loadActivations(path: string): ModelOutput {
  const bytes = gunzipSync(readFileSync(path));
  const rows = bytes.length / (2 * 2 * COLUMNS);
  if (!Number.isInteger(rows)) throw new Error(`${path}: unexpected size ${bytes.length}`);
  const matrix = (offset: number): number[][] => {
    const out: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const row = new Array<number>(COLUMNS);
      for (let c = 0; c < COLUMNS; c++) row[c] = bytes.readUInt16LE(offset + (r * COLUMNS + c) * 2) / 1000;
      out.push(row);
    }
    return out;
  };
  return { frames: matrix(0), onsets: matrix(rows * COLUMNS * 2) };
}
