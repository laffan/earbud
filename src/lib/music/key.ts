/**
 * Key of a passage, and chords read in that key.
 *
 * Key finding is Krumhansl–Schmuckler: a 12-bin pitch-class profile of the
 * notes (each weighted by how long it sounds, its loudness and the engine's
 * confidence) is correlated with the Krumhansl–Kessler major and minor key
 * profiles rotated to every tonic; the best of the 24 wins. Its confidence is
 * how far it is ahead of the runner-up, so a passage that sits between two
 * keys (often relative major and minor) says so.
 */
import type { PianoNote } from '../transcription/types';
import { formatChord, type ChordSegment } from './chords';
import { PITCH_CLASS_NAMES, pitchClass } from './notes';

export type Mode = 'major' | 'minor';

export interface Key {
  /** Pitch class of the tonic (0 = C). */
  tonic: number;
  mode: Mode;
}

export interface KeyEstimate extends Key {
  /** Correlation with the key's profile, −1–1. */
  score: number;
  /** The next best key, when it comes close. */
  alternative: (Key & { score: number }) | null;
  /** 0–1: how clearly the best key beats the next. */
  confidence: number;
}

/** Krumhansl & Kessler (1982) probe-tone ratings, from the tonic up. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
/** Fewer distinct sounding pitch classes than this give no key. */
const MIN_PITCH_CLASSES = 4;
/** A runner-up within this much correlation of the best is reported as an alternative. */
const CLOSE = 0.08;

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/** Duration-weighted pitch-class profile of the notes. */
export function pitchClassProfile(notes: PianoNote[]): number[] {
  const profile = new Array<number>(12).fill(0);
  for (const n of notes) {
    const length = Math.max(0, n.endTime - n.startTime);
    const velocity = 0.4 + 0.6 * Math.min(1, Math.max(0, n.velocity / 127));
    const confidence = Math.sqrt(Math.min(1, Math.max(0.05, n.confidence ?? 1)));
    // Long held notes count, but not without limit (a pedal tone would swamp the rest).
    profile[pitchClass(n.pitch)] += Math.min(length, 2) * velocity * confidence;
  }
  return profile;
}

/** The most likely key of `notes`, or null when there is too little to go on. */
export function detectKey(notes: PianoNote[]): KeyEstimate | null {
  const profile = pitchClassProfile(notes);
  const max = Math.max(...profile);
  if (max <= 0 || profile.filter((w) => w > 0.05 * max).length < MIN_PITCH_CLASSES) return null;
  const scores: (Key & { score: number })[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const template = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = profile.map((_, pc) => template[(pc - tonic + 12) % 12]);
      scores.push({ tonic, mode, score: correlation(profile, rotated) });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  const gap = best.score - second.score;
  return {
    tonic: best.tonic,
    mode: best.mode,
    score: best.score,
    alternative: gap < CLOSE ? second : null,
    confidence: Math.max(0, Math.min(1, gap / (2 * CLOSE))),
  };
}

// ---------------------------------------------------------------- spelling

export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
/** Tonics written as usual: majors with flats except G, D, A, E, B, F♯; minors with sharps for E, B, F♯, C♯, G♯. */
const MAJOR_TONIC_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_TONIC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

export function keyName(key: Key): string {
  const names = key.mode === 'major' ? MAJOR_TONIC_NAMES : MINOR_TONIC_NAMES;
  return `${names[key.tonic]} ${key.mode}`;
}

/** Note names that fit the key's signature (sharps in sharp keys, flats in flat keys). */
export function noteNamesFor(key: Key | null): readonly string[] {
  if (!key) return PITCH_CLASS_NAMES;
  // The relative major decides the signature.
  const major = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  if (major === 0) return PITCH_CLASS_NAMES;
  const sharps = [7, 2, 9, 4, 11, 6].includes(major);
  return sharps ? SHARP_NAMES : FLAT_NAMES;
}

/** A chord's symbol spelled for the key. */
export function spellChord(chord: Pick<ChordSegment, 'root' | 'quality' | 'bass'>, key: Key | null): string {
  return formatChord(chord.root, chord.quality, chord.bass, noteNamesFor(key));
}

// ---------------------------------------------------------- roman numerals

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const MINOR_QUALITIES = new Set(['m', 'm7', 'm6', 'm9', 'mMaj7']);
const DIMINISHED_QUALITIES = new Set(['dim', 'dim7', 'm7b5']);
/** What follows the numeral, by quality (the numeral's case and ° / ø / + say the rest). */
const NUMERAL_SUFFIX: Record<string, string> = {
  M: '',
  m: '',
  dim: '°',
  aug: '+',
  sus2: 'sus2',
  sus4: 'sus4',
  '7': '7',
  maj7: 'maj7',
  m7: '7',
  m7b5: 'ø7',
  dim7: '°7',
  mMaj7: '(maj7)',
  '6': '6',
  m6: '6',
  add9: 'add9',
  '9': '9',
  maj9: 'maj9',
  m9: '9',
  '7sus4': '7sus4',
};

/** Chords with a minor third (drawn on the circle's minor ring, numerals in lower case). */
export function isMinorQuality(quality: string): boolean {
  return MINOR_QUALITIES.has(quality);
}

export function isDiminishedQuality(quality: string): boolean {
  return DIMINISHED_QUALITIES.has(quality);
}

/**
 * Roman numeral of a chord in a key, e.g. `vi7` or `♭VII` (secondary
 * dominants are not named as such). Roots outside the scale get ♭, or in a
 * minor key ♯ for the raised third and sixth; the raised seventh (the leading
 * tone of harmonic minor) is written plain.
 */
export function romanNumeral(chord: Pick<ChordSegment, 'root' | 'quality'>, key: Key): string {
  const interval = (chord.root - key.tonic + 12) % 12;
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  let degree = scale.indexOf(interval);
  let accidental = '';
  if (degree < 0) {
    if (key.mode === 'minor' && interval === 11) degree = 6; // harmonic minor's leading tone
    else if (key.mode === 'minor' && interval === 9) {
      degree = 5;
      accidental = '♯';
    } else if (key.mode === 'minor' && interval === 4) {
      degree = 2;
      accidental = '♯';
    } else {
      degree = scale.indexOf(interval + 1);
      accidental = '♭';
      if (degree < 0) {
        degree = scale.indexOf(interval - 1);
        accidental = '♯';
      }
    }
  }
  const lower = isMinorQuality(chord.quality) || isDiminishedQuality(chord.quality);
  const numeral = lower ? NUMERALS[degree].toLowerCase() : NUMERALS[degree];
  return `${accidental}${numeral}${NUMERAL_SUFFIX[chord.quality] ?? ''}`;
}

/** Chord quality in words. */
const QUALITY_WORDS: Record<string, string> = {
  M: 'major',
  m: 'minor',
  dim: 'diminished',
  aug: 'augmented',
  sus2: 'suspended second',
  sus4: 'suspended fourth',
  '7': 'dominant seventh',
  maj7: 'major seventh',
  m7: 'minor seventh',
  m7b5: 'half-diminished seventh',
  dim7: 'diminished seventh',
  mMaj7: 'minor major seventh',
  '6': 'major sixth',
  m6: 'minor sixth',
  add9: 'added ninth',
  '9': 'dominant ninth',
  maj9: 'major ninth',
  m9: 'minor ninth',
  '7sus4': 'seventh, suspended fourth',
};

/** E.g. "A minor seventh, C in the bass". */
export function chordInWords(chord: Pick<ChordSegment, 'root' | 'quality' | 'bass'>, key: Key | null): string {
  const names = noteNamesFor(key);
  const base = `${names[chord.root]} ${QUALITY_WORDS[chord.quality] ?? chord.quality}`;
  return chord.bass !== chord.root ? `${base}, ${names[chord.bass]} in the bass` : base;
}
