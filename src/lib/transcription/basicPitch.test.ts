/**
 * End-to-end check of the real Basic Pitch model (CPU backend) on
 * synthesized two-handed piano chords, through the music engine.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GraphModel } from '@tensorflow/tfjs';
import { synthesize } from '../testing/synth';
import { detectChords } from '../music/chords';
import {
  BASIC_PITCH_SAMPLE_RATE,
  BASIC_PITCH_VERSION,
  DEFAULT_BASIC_PITCH_PARAMS,
  loadModel,
  notesFromModelOutput,
  runModel,
  selectBackend,
  TakeCache,
  transcribeSamples,
} from './basicPitchCore';
import { transcriptionParams } from './settings';

const modelDir = join(__dirname, '../../../public/models/basic-pitch');
let model: GraphModel;

beforeAll(async () => {
  await selectBackend(['cpu']);
  const json = JSON.parse(readFileSync(join(modelDir, 'model.json'), 'utf8'));
  const bin = readFileSync(join(modelDir, 'group1-shard1of1.bin'));
  model = await loadModel({
    json,
    weights: bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer,
  });
});

describe('Basic Pitch transcription', () => {
  it('pins the engine version to the installed package', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../../node_modules/@spotify/basic-pitch/package.json'), 'utf8'),
    );
    expect(BASIC_PITCH_VERSION).toBe(pkg.version);
  });

  it('transcribes a two-handed chord progression', async () => {
    // Left hand bass + right hand triads: C/C, Am/A, F/F, G/G.
    const progression = [
      { bass: 36, triad: [60, 64, 67] },
      { bass: 45, triad: [57, 60, 64] },
      { bass: 41, triad: [57, 60, 65] },
      { bass: 43, triad: [55, 59, 62] },
    ];
    const tones = progression.flatMap((c, i) =>
      [c.bass, ...c.triad].map((pitch) => ({ pitch, start: 0.3 + i * 1.2, end: 1.3 + i * 1.2 })),
    );
    const samples = synthesize(tones, BASIC_PITCH_SAMPLE_RATE, 5.4);
    let lastProgress = 0;
    const output = await runModel(model, samples, (p) => (lastProgress = p));
    expect(lastProgress).toBe(1);
    expect(output.frames.length).toBe(Math.floor(samples.length * (86 / 22050)));

    const notes = notesFromModelOutput(output);
    for (const [i, c] of progression.entries()) {
      const start = 0.3 + i * 1.2;
      const found = notes.filter((n) => Math.abs(n.startTime - start) < 0.08).map((n) => n.pitch);
      for (const pitch of [c.bass, ...c.triad]) expect(found).toContain(pitch);
    }
    for (const n of notes) {
      expect(n.endTime).toBeGreaterThan(n.startTime);
      expect(n.velocity).toBeGreaterThanOrEqual(1);
      expect(n.velocity).toBeLessThanOrEqual(127);
    }
    expect(detectChords(notes).map((c) => c.symbol)).toEqual(['C', 'Am', 'F', 'G']);
  });

  it('returns no notes for silence', async () => {
    const output = await runModel(model, new Float32Array(BASIC_PITCH_SAMPLE_RATE * 2));
    expect(notesFromModelOutput(output)).toEqual([]);
  });

  it('transcribes a take again with other settings without running the model again', async () => {
    const samples = synthesize(
      [
        { pitch: 48, start: 0.2, end: 2.6 },
        { pitch: 64, start: 0.8, end: 1.4 },
        { pitch: 67, start: 1.6, end: 2.2 },
      ],
      BASIC_PITCH_SAMPLE_RATE,
      3,
    );
    const cache = new TakeCache();
    const progress: number[] = [];
    const base = { environment: 'room', custom: { noiseGateDb: null, requireStrike: false, strikeOnset: 0.5, minNoteLengthMs: 127.7 } } as const;
    const first = await transcribeSamples(model, samples, { ...DEFAULT_BASIC_PITCH_PARAMS, ...transcriptionParams({ ...base, heldNotes: 'off' }) }, {
      key: 'take',
      cache,
      onProgress: (f) => progress.push(f),
    });
    const windows = progress.length;
    expect(windows).toBeGreaterThan(1);

    const again = await transcribeSamples(model, samples, { ...DEFAULT_BASIC_PITCH_PARAMS, ...transcriptionParams({ ...base, heldNotes: 'join' }) }, {
      key: 'take',
      cache,
      onProgress: (f) => progress.push(f),
    });
    // Only the final "done" report: the model did not run.
    expect(progress.slice(windows)).toEqual([1]);
    expect(again.map((n) => n.pitch).sort()).toEqual([...new Set(first.map((n) => n.pitch))].sort());

    // A different take (other length) under the same key runs the model again.
    await transcribeSamples(model, samples.subarray(0, samples.length - 512), DEFAULT_BASIC_PITCH_PARAMS, {
      key: 'take',
      cache,
      onProgress: (f) => progress.push(f),
    });
    expect(progress.length - windows - 1).toBeGreaterThan(1);
  });
});
