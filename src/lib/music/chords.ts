/**
 * Chord identification from (possibly noisy) polyphonic note events.
 *
 * 1. Split time at onset clusters (notes struck together within ~70 ms).
 * 2. For each span, build a 12-bin pitch-class profile weighted by how long
 *    each note sounds in the span, its velocity and the engine confidence.
 * 3. Score every root × chord quality (templates from tonal's ChordType
 *    dictionary) by how much of the profile it explains and how complete it
 *    is, with small priors for simpler chords and for root-position bass.
 * 4. Grow a window greedily while the best chord stays the same, so melody
 *    notes over a held chord do not fragment it.
 *
 * Only chords above a confidence threshold are reported: it is better to
 * show nothing than a wrong name.
 */
import { ChordType } from 'tonal';
import type { PianoNote } from '../transcription/types';
import { PITCH_CLASS_NAMES, pitchClass } from './notes';

export interface ChordSegment {
  startTime: number;
  endTime: number;
  /** Display symbol, e.g. `Am7/C`. */
  symbol: string;
  /** Pitch class of the root (0 = C). */
  root: number;
  /** Pitch class of the lowest sounding note. */
  bass: number;
  /** Chord quality as named in tonal's dictionary, e.g. `m7`. */
  quality: string;
  /** 0–1: share of the sounding notes the chord explains × completeness. */
  confidence: number;
}

export interface ChordOptions {
  /** Onsets closer than this are treated as one strike (s). */
  onsetMergeWindow: number;
  /** Chords shorter than this are dropped (s). */
  minDuration: number;
  minConfidence: number;
  /** Distinct pitch classes required before naming a chord. */
  minPitchClasses: number;
}

export const DEFAULT_CHORD_OPTIONS: Readonly<ChordOptions> = Object.freeze({
  onsetMergeWindow: 0.07,
  minDuration: 0.2,
  minConfidence: 0.62,
  minPitchClasses: 3,
});

interface Quality {
  type: string;
  suffix: string;
  intervals: number[];
}

/** Lead-sheet suffixes for the tonal chord types we recognise. */
const SUFFIXES: Record<string, string> = {
  M: '',
  m: 'm',
  dim: 'dim',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  m7b5: 'm7♭5',
  dim7: 'dim7',
  mMaj7: 'm(maj7)',
  '6': '6',
  m6: 'm6',
  add9: 'add9',
  '9': '9',
  maj9: 'maj9',
  m9: 'm9',
  '7sus4': '7sus4',
};

const QUALITIES: Quality[] = Object.entries(SUFFIXES).map(([type, suffix]) => {
  const chord = ChordType.get(type);
  if (chord.empty) throw new Error(`Unknown chord type ${type}`);
  const intervals: number[] = [];
  for (let i = 0; i < 12; i++) if (chord.chroma[i] === '1') intervals.push(i);
  return { type, suffix, intervals };
});

type Profile = { weights: Float64Array; bassPitch: number; bassWeight: Map<number, number> };

interface Span {
  start: number;
  end: number;
  profile: Profile;
  /** Notes struck at the start of this span. */
  onsets: number;
}

interface Candidate {
  root: number;
  quality: Quality;
  confidence: number;
  score: number;
}

function emptyProfile(): Profile {
  return { weights: new Float64Array(12), bassPitch: Infinity, bassWeight: new Map() };
}

function addNoteToProfile(profile: Profile, note: PianoNote, start: number, end: number) {
  const overlap = Math.min(end, note.endTime) - Math.max(start, note.startTime);
  if (overlap <= 0) return;
  // Freshly struck notes matter more than tails ringing into the next chord.
  const attack = note.startTime >= start - 0.02 ? 1 : 0.6;
  const velocity = 0.4 + 0.6 * Math.min(1, Math.max(0, note.velocity / 127));
  const confidence = Math.sqrt(Math.min(1, Math.max(0.05, note.confidence ?? 1)));
  const w = overlap * attack * velocity * confidence;
  profile.weights[pitchClass(note.pitch)] += w;
  // Bass: lowest pitch that sounds for a meaningful part of the span.
  if (overlap >= 0.4 * (end - start)) {
    profile.bassWeight.set(note.pitch, (profile.bassWeight.get(note.pitch) ?? 0) + w);
    profile.bassPitch = Math.min(profile.bassPitch, note.pitch);
  }
}

function mergeProfiles(a: Profile, b: Profile): Profile {
  const out = emptyProfile();
  for (let i = 0; i < 12; i++) out.weights[i] = a.weights[i] + b.weights[i];
  out.bassPitch = Math.min(a.bassPitch, b.bassPitch);
  for (const src of [a.bassWeight, b.bassWeight]) {
    for (const [p, w] of src) out.bassWeight.set(p, (out.bassWeight.get(p) ?? 0) + w);
  }
  return out;
}

function bassPitchClass(profile: Profile): number | null {
  if (!Number.isFinite(profile.bassPitch)) return null;
  return pitchClass(profile.bassPitch);
}

interface ProfileStats {
  total: number;
  present: boolean[];
  bass: number | null;
}

function profileStats(profile: Profile): ProfileStats {
  const w = profile.weights;
  let total = 0;
  let max = 0;
  for (let i = 0; i < 12; i++) {
    total += w[i];
    max = Math.max(max, w[i]);
  }
  return { total, present: Array.from(w, (x) => max > 0 && x >= 0.12 * max), bass: bassPitchClass(profile) };
}

/** How well `root` + `quality` explains a profile. */
function evaluate(profile: Profile, stats: ProfileStats, root: number, quality: Quality): Candidate {
  const w = profile.weights;
  let explained = 0;
  let missing = 0;
  for (const interval of quality.intervals) {
    const pc = (root + interval) % 12;
    explained += w[pc];
    if (!stats.present[pc]) {
      // Pianists routinely omit the fifth in four-note voicings.
      missing += interval === 7 && quality.intervals.length >= 4 ? 0.3 : 1;
    }
  }
  const completeness = 1 - missing / quality.intervals.length;
  const confidence = stats.total > 0 ? (explained / stats.total) * completeness : 0;
  const score =
    confidence - 0.015 * (quality.intervals.length - 3) + (stats.bass === root ? 0.04 : 0);
  return { root, quality, confidence, score };
}

/** Best chord for a pitch-class profile, or null if nothing fits well. */
function bestChord(profile: Profile, options: ChordOptions): Candidate | null {
  const stats = profileStats(profile);
  if (stats.total <= 0) return null;
  if (stats.present.filter(Boolean).length < options.minPitchClasses) return null;
  let best: Candidate | null = null;
  for (let root = 0; root < 12; root++) {
    if (!stats.present[root]) continue;
    for (const quality of QUALITIES) {
      const candidate = evaluate(profile, stats, root, quality);
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  if (!best || best.confidence < options.minConfidence) return null;
  return best;
}

function symbolFor(candidate: Candidate, bass: number | null): string {
  const root = PITCH_CLASS_NAMES[candidate.root];
  const base = `${root}${candidate.quality.suffix}`;
  if (bass === null || bass === candidate.root) return base;
  return `${base}/${PITCH_CLASS_NAMES[bass]}`;
}

function sameChord(a: Candidate | null, b: Candidate | null): boolean {
  return !!a && !!b && a.root === b.root && a.quality.type === b.quality.type;
}

/** Split the timeline at onset clusters and profile each span. */
function buildSpans(notes: PianoNote[], options: ChordOptions): Span[] {
  const sorted = [...notes].sort((a, b) => a.startTime - b.startTime);
  if (sorted.length === 0) return [];
  const boundaries: number[] = [];
  for (const note of sorted) {
    const last = boundaries[boundaries.length - 1];
    if (last === undefined || note.startTime - last > options.onsetMergeWindow) {
      boundaries.push(note.startTime);
    }
  }
  const end = sorted.reduce((t, n) => Math.max(t, n.endTime), 0);
  boundaries.push(end);

  const spans: Span[] = [];
  let next = 0;
  let active: PianoNote[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const stop = boundaries[i + 1];
    if (stop - start <= 1e-6) continue;
    active = active.filter((n) => n.endTime > start);
    while (next < sorted.length && sorted[next].startTime < stop) active.push(sorted[next++]);
    const profile = emptyProfile();
    let onsets = 0;
    for (const note of active) {
      addNoteToProfile(profile, note, start, stop);
      if (note.startTime >= start - 1e-6 && note.startTime < start + options.onsetMergeWindow) onsets++;
    }
    spans.push({ start, end: stop, profile, onsets });
  }
  return spans;
}

export function detectChords(
  notes: PianoNote[],
  overrides: Partial<ChordOptions> = {},
): ChordSegment[] {
  const options: ChordOptions = { ...DEFAULT_CHORD_OPTIONS, ...overrides };
  const spans = buildSpans(notes, options);
  const windows: { start: number; end: number; profile: Profile; chord: Candidate | null }[] = [];

  for (const span of spans) {
    const spanChord = bestChord(span.profile, options);
    const current = windows[windows.length - 1];
    if (current && span.start - current.end < 0.5) {
      const merged = mergeProfiles(current.profile, span.profile);
      if (current.chord) {
        // A fresh strike of three or more notes that forms a different chord
        // starts a new window; otherwise the window continues as long as its
        // chord still explains the music (melody and passing notes).
        const newChordStruck =
          span.onsets >= options.minPitchClasses && !!spanChord && !sameChord(spanChord, current.chord);
        const held = evaluate(merged, profileStats(merged), current.chord.root, current.chord.quality);
        if (!newChordStruck && held.confidence >= options.minConfidence) {
          current.end = span.end;
          current.profile = merged;
          current.chord = held;
          continue;
        }
      } else {
        // An unclear window that becomes clear with more context.
        const mergedChord = bestChord(merged, options);
        if (mergedChord && (!spanChord || sameChord(mergedChord, spanChord))) {
          current.end = span.end;
          current.profile = merged;
          current.chord = mergedChord;
          continue;
        }
      }
    }
    windows.push({ start: span.start, end: span.end, profile: span.profile, chord: spanChord });
  }

  const segments: ChordSegment[] = [];
  for (const window of windows) {
    if (!window.chord || window.end - window.start < options.minDuration) continue;
    const bass = bassPitchClass(window.profile);
    const segment: ChordSegment = {
      startTime: window.start,
      endTime: window.end,
      symbol: symbolFor(window.chord, bass),
      root: window.chord.root,
      bass: bass ?? window.chord.root,
      quality: window.chord.quality.type,
      confidence: Math.round(window.chord.confidence * 100) / 100,
    };
    const previous = segments[segments.length - 1];
    if (previous && previous.symbol === segment.symbol && segment.startTime - previous.endTime < 0.3) {
      previous.endTime = segment.endTime;
      previous.confidence = Math.max(previous.confidence, segment.confidence);
    } else {
      segments.push(segment);
    }
  }
  return segments;
}

/** Consecutive distinct chord symbols, e.g. for a list preview. */
export function chordProgression(segments: ChordSegment[], limit = 8): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (out[out.length - 1] !== s.symbol) out.push(s.symbol);
    if (out.length >= limit) break;
  }
  return out;
}

/** Pitch classes of a detected chord (root + chord tones). */
export function chordTones(chord: Pick<ChordSegment, 'root' | 'quality'>): number[] {
  const quality = QUALITIES.find((q) => q.type === chord.quality);
  const intervals = quality?.intervals ?? [0, 4, 7];
  return intervals.map((i) => (chord.root + i) % 12);
}

/**
 * Notes to play when a chord is tapped: the chord tones that were actually
 * struck at that moment (so it sounds like the take), or a plain voicing
 * built from the chord symbol when too few were found.
 */
export function chordVoicing(chord: ChordSegment, notes: PianoNote[]): number[] {
  const tones = new Set(chordTones(chord));
  const t0 = chord.startTime;
  const struck = notes.filter((n) => n.startTime >= t0 - 0.05 && n.startTime < t0 + 0.2);
  const sounding = notes.filter((n) => n.startTime <= t0 + 0.1 && n.endTime > t0 + 0.1);
  const source = struck.length >= 3 ? struck : [...struck, ...sounding];
  const pitches = [...new Set(source.filter((n) => tones.has(pitchClass(n.pitch))).map((n) => n.pitch))];
  if (new Set(pitches.map(pitchClass)).size >= Math.min(3, tones.size)) {
    return pitches.sort((a, b) => a - b);
  }
  // Fallback: bass note in octave 3, chord tones stacked from middle C.
  const voicing = [48 + chord.bass];
  let previous = 59;
  for (const pc of chordTones(chord)) {
    let pitch = 60 + pc;
    while (pitch <= previous) pitch += 12;
    while (pitch - 12 > previous) pitch -= 12;
    voicing.push(pitch);
    previous = pitch;
  }
  return voicing;
}
