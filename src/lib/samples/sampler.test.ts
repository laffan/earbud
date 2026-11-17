// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { NoteSynth } from '../music/synth';
import { FakeAudioContext, fakeBuffer } from '../testing/fakeAudioContext';
import { scheduleSampleNote } from './render';

describe('notes played with a sample', () => {
  it('resamples the sample from its root to each note, in tune', () => {
    const ctx = new FakeAudioContext();
    const sample = { buffer: fakeBuffer(2, 48000), root: 57.2 }; // A3, 20 cents sharp
    scheduleSampleNote(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, sample, 69, 100, 0.5, 0.4);
    expect(ctx.sources[0].rate).toBeCloseTo(2 ** ((69 - 57.2) / 12), 6);
    expect(ctx.sources[0].when).toBe(0.5);
    // Held for its length, then released.
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(0.5 + 0.4 + 0.12 + 0.02, 6);
  });

  it('ends with the sample when the note is longer than it', () => {
    const ctx = new FakeAudioContext();
    scheduleSampleNote(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { buffer: fakeBuffer(0.5, 48000), root: 60 }, 72, 100, 0, 5);
    // An octave up plays it twice as fast: a quarter of a second.
    expect(ctx.sources[0].stoppedAt).toBeCloseTo(0.25 + 0.02, 6);
  });

  it('is what the synth plays notes with, until it goes back to the piano', () => {
    const ctx = new FakeAudioContext();
    const synth = new NoteSynth({ context: () => ctx as unknown as AudioContext });
    synth.preview(60);
    expect(ctx.started.length).toBeGreaterThan(0); // the piano: oscillators
    expect(ctx.sources).toHaveLength(0);
    synth.setSampler({ buffer: fakeBuffer(1, 48000), root: 48 });
    synth.preview(60);
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].rate).toBeCloseTo(2, 6);
    // Piano chords stay on the piano.
    const oscillators = ctx.started.length;
    synth.playChord([60, 64, 67], 80, 1, 0, 'piano');
    expect(ctx.started.length).toBeGreaterThan(oscillators);
    expect(ctx.sources).toHaveLength(1);
    synth.setSampler(null);
    synth.preview(62);
    expect(ctx.sources).toHaveLength(1);
  });
});
