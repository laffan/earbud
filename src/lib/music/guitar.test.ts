import { describe, expect, it } from 'vitest';
import { FakeAudioContext, fakeBuffer } from '../testing/fakeAudioContext';
import { GUITAR_SAMPLE_NOTES, nearestZone, strumGuitar } from './guitar';

describe('guitar', () => {
  const zones = GUITAR_SAMPLE_NOTES.map((root) => ({ root, buffer: fakeBuffer(2.6, 44100) }));

  it('plays each note from a recording at most two semitones away', () => {
    for (let pitch = 40; pitch <= 82; pitch++) {
      expect(Math.abs(nearestZone(zones, pitch).root - pitch)).toBeLessThanOrEqual(2);
    }
  });

  it('strums from the lowest note up, each resampled to its pitch', () => {
    const ctx = new FakeAudioContext();
    const voices = strumGuitar(ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, zones, [64, 40, 52], 1, { spread: 0.03 });
    expect(voices.map((v) => v.start)).toEqual([1, 1.03, 1.06]);
    const rates = ctx.sources.map((s) => s.rate);
    expect(rates).toEqual([1, 1, 1]);
    const shifted = new FakeAudioContext();
    strumGuitar(shifted as unknown as BaseAudioContext, shifted.destination as unknown as AudioNode, zones, [41], 0);
    expect(shifted.sources[0].rate).toBeCloseTo(2 ** (1 / 12), 6);
  });
});
