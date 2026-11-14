import { describe, expect, it } from 'vitest';
import type { PianoNote } from '../transcription/types';
import { chordInWords, detectKey, keyName, noteNamesFor, romanNumeral, spellChord } from './key';

/** Block chords, one per second: [root MIDI, intervals]. */
function progression(chords: [number, number[]][]): PianoNote[] {
  return chords.flatMap(([root, intervals], i) =>
    intervals.map((iv) => ({ pitch: root + iv, startTime: i, endTime: i + 0.95, velocity: 80 })),
  );
}
const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];

describe('detectKey', () => {
  it('finds C major from I–vi–IV–V', () => {
    const key = detectKey(progression([[60, MAJ], [57, MIN], [53, MAJ], [55, MAJ], [60, MAJ]]));
    expect(key && keyName(key)).toBe('C major');
  });

  it('finds A minor from i–iv–V–i', () => {
    const key = detectKey(progression([[57, MIN], [62, MIN], [64, MAJ], [57, MIN], [57, MIN]]));
    expect(key && keyName(key)).toBe('A minor');
  });

  it('finds E♭ major', () => {
    const key = detectKey(progression([[63, MAJ], [56, MAJ], [58, MAJ], [63, MAJ]]));
    expect(key && keyName(key)).toBe('E♭ major');
  });

  it('gives no key for too little material', () => {
    expect(detectKey([{ pitch: 60, startTime: 0, endTime: 1, velocity: 80 }])).toBeNull();
  });
});

describe('chords in a key', () => {
  const C = { tonic: 0, mode: 'major' as const };
  const Am = { tonic: 9, mode: 'minor' as const };
  it('numbers chords with roman numerals', () => {
    expect(romanNumeral({ root: 0, quality: 'M' }, C)).toBe('I');
    expect(romanNumeral({ root: 9, quality: 'm7' }, C)).toBe('vi7');
    expect(romanNumeral({ root: 7, quality: '7' }, C)).toBe('V7');
    expect(romanNumeral({ root: 11, quality: 'm7b5' }, C)).toBe('viiø7');
    expect(romanNumeral({ root: 10, quality: 'M' }, C)).toBe('♭VII');
    expect(romanNumeral({ root: 4, quality: 'M' }, Am)).toBe('V');
    expect(romanNumeral({ root: 0, quality: 'M' }, Am)).toBe('III');
    expect(romanNumeral({ root: 8, quality: 'dim' }, Am)).toBe('vii°');
  });

  it('spells chords with the key’s sharps or flats', () => {
    expect(noteNamesFor({ tonic: 4, mode: 'major' })[8]).toBe('G♯');
    expect(noteNamesFor({ tonic: 5, mode: 'major' })[10]).toBe('B♭');
    expect(spellChord({ root: 8, quality: 'm', bass: 8 }, { tonic: 4, mode: 'major' })).toBe('G♯m');
    expect(spellChord({ root: 8, quality: 'M', bass: 0 }, { tonic: 3, mode: 'major' })).toBe('A♭/C');
    expect(chordInWords({ root: 9, quality: 'm7', bass: 0 }, C)).toBe('A minor seventh, C in the bass');
  });
});
