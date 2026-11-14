import { describe, expect, it } from 'vitest';
import { chordTones } from './chords';
import { pitchClass } from './notes';
import { GUITAR_TUNING, guitarVoicings, pianoVoicing } from './voicings';

/** A shape written the usual way: low E first, x = muted. */
const tab = (frets: number[]) => frets.map((f) => (f < 0 ? 'x' : String(f))).join('');
const best = (root: number, quality: string, bass = root) => tab(guitarVoicings(root, quality, bass)[0].frets);

describe('guitarVoicings', () => {
  it.each([
    ['C', 0, 'M', 0, 'x32010'],
    ['G', 7, 'M', 7, '320003'],
    ['D', 2, 'M', 2, 'xx0232'],
    ['A', 9, 'M', 9, 'x02220'],
    ['E', 4, 'M', 4, '022100'],
    ['Am', 9, 'm', 9, 'x02210'],
    ['Em', 4, 'm', 4, '022000'],
    ['Dm', 2, 'm', 2, 'xx0231'],
    ['G7', 7, '7', 7, '320001'],
    ['E7', 4, '7', 4, '020100'],
    ['Am7', 9, 'm7', 9, 'x02010'],
    ['Cmaj7', 0, 'maj7', 0, 'x32000'],
    ['C/E', 0, 'M', 4, '032010'],
    ['C/G', 0, 'M', 7, '332010'],
  ])('plays %s in its usual open shape', (_name, root, quality, bass, expected) => {
    expect(best(root as number, quality as string, bass as number)).toBe(expected);
  });

  it.each([
    ['F', 5, 'M'],
    ['Bm', 11, 'm'],
    ['B♭', 10, 'M'],
    ['F♯m', 6, 'm'],
  ])('plays %s as a barre chord', (_name, root, quality) => {
    const v = guitarVoicings(root as number, quality as string)[0];
    expect(v.barre).not.toBeNull();
    expect(v.fingers).toBeLessThanOrEqual(4);
  });

  it('finds a playable shape for every chord quality and root, with the right notes', () => {
    const qualities = ['M', 'm', 'dim', 'aug', 'sus2', 'sus4', '7', 'maj7', 'm7', 'm7b5', 'dim7', 'mMaj7', '6', 'm6', 'add9', '9', 'maj9', 'm9', '7sus4'];
    for (const quality of qualities) {
      for (let root = 0; root < 12; root++) {
        const shapes = guitarVoicings(root, quality);
        expect(shapes.length, `${root} ${quality}`).toBeGreaterThan(0);
        for (const v of shapes) {
          const sounding = v.frets.map((f, s) => (f >= 0 ? pitchClass(GUITAR_TUNING[s] + f) : null)).filter((p) => p !== null);
          const tones = new Set(chordTones({ root, quality }));
          expect(sounding.every((p) => tones.has(p!))).toBe(true);
          expect(sounding[0]).toBe(root);
          expect(v.fingers).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it('offers alternatives further up the neck', () => {
    const shapes = guitarVoicings(9, 'm');
    expect(shapes.length).toBeGreaterThan(1);
    const positions = shapes.map((s) => s.position);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('pianoVoicing', () => {
  it('puts the chord in root position around middle C with the bass below', () => {
    expect(pianoVoicing(0, 'M')).toEqual({ left: [48], right: [60, 64, 67] });
    expect(pianoVoicing(9, 'm7')).toEqual({ left: [45], right: [57, 60, 64, 67] });
  });

  it('plays a slash chord’s bass in the left hand', () => {
    const v = pianoVoicing(0, 'M', 4);
    expect(v.left).toEqual([52]);
    expect(v.right).toEqual([60, 64, 67]);
  });
});
