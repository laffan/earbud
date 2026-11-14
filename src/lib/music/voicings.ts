/**
 * How to play a chord: a piano voicing (left-hand bass, right-hand chord in
 * root position around middle C) and guitar fingerings in standard tuning.
 *
 * Guitar fingerings are searched, not looked up, so every recognised chord
 * (19 qualities × 12 roots, with any bass) gets one. For each position up
 * the neck, every string may be muted or fretted (within a four-fret span,
 * open strings near the nut) on a chord tone; a shape is kept when its lowest
 * note is the bass, it has every chord tone (a fifth may be left out of four-
 * and five-note chords), at least four strings sound with no muted string
 * between them (nor, past the third fret, an open one), and it needs at
 * most four fingers (a barre counts as one). Shapes are ranked by how easy
 * they are: low positions, open strings, few fingers, all six strings, and
 * a barre only where it saves fingers; shapes where the fingers would cross
 * (two on one fret with one further up between them) are left out. The
 * common open chords and the usual barre chords come out in their usual
 * shapes (see the tests).
 */
import { chordTones } from './chords';
import { pitchClass } from './notes';

export interface PianoVoicing {
  /** Left hand: the bass note (the root, or the slash chord's bass). */
  left: number[];
  /** Right hand: the chord tones in root position. */
  right: number[];
}

/** Bass in the octave below the right hand; right hand from the root, rooted between G3 and F♯4. */
export function pianoVoicing(root: number, quality: string, bass: number = root): PianoVoicing {
  let start = 48 + root; // C3–B3
  while (start < 55) start += 12; // G3–F♯4
  while (start > 66) start -= 12;
  const right: number[] = [];
  let previous = start - 1;
  for (const pc of chordTones({ root, quality })) {
    let pitch = start + ((pc - root + 12) % 12);
    while (pitch <= previous) pitch += 12;
    right.push(pitch);
    previous = pitch;
  }
  right.sort((a, b) => a - b);
  let low = right[0] - 12 + ((bass - pitchClass(right[0]) + 12) % 12);
  if (low >= right[0]) low -= 12;
  return { left: [low], right };
}

// ------------------------------------------------------------------ guitar

/** Standard tuning, low E to high E (MIDI). */
export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64];

export interface GuitarVoicing {
  /** Fret per string, low E first; -1 = muted, 0 = open. */
  frets: number[];
  /** A barre across strings `from`–`to` (indices) at `fret`, if the shape uses one. */
  barre: { fret: number; from: number; to: number } | null;
  /** Fingers needed (a barre counts as one). */
  fingers: number;
  /** Lowest fretted fret (1 for open shapes). */
  position: number;
  /** Lower is easier. */
  cost: number;
}

const SPAN = 4;
const MAX_POSITION = 12;

const shapes = new Map<string, GuitarVoicing[]>();

/** Playable shapes for a chord, easiest first, one per neck position (at most `limit`). Cached. */
export function guitarVoicings(root: number, quality: string, bass: number = root, limit = 4): GuitarVoicing[] {
  const id = `${root}:${quality}:${bass}:${limit}`;
  let found = shapes.get(id);
  if (!found) {
    found = searchVoicings(root, quality, bass, limit);
    shapes.set(id, found);
  }
  return found;
}

function searchVoicings(root: number, quality: string, bass: number, limit: number): GuitarVoicing[] {
  const tones = chordTones({ root, quality });
  const toneSet = new Set(tones);
  const fifth = (root + 7) % 12;
  // A fifth may be left out of four- and five-note chords (as guitarists do).
  const optional = tones.length >= 4 && toneSet.has(fifth) ? fifth : null;
  const required = tones.filter((t) => t !== optional);
  const found = new Map<string, GuitarVoicing>();

  for (let base = 0; base <= MAX_POSITION; base++) {
    const frets = base === 0 ? [1, 2, 3] : Array.from({ length: SPAN }, (_, i) => base + i);
    const openAllowed = base <= 1;
    const options = GUITAR_TUNING.map((open) => {
      const list = [-1];
      if (openAllowed && toneSet.has(pitchClass(open))) list.push(0);
      for (const f of frets) if (toneSet.has(pitchClass(open + f))) list.push(f);
      return list;
    });
    const shape = new Array<number>(6).fill(-1);
    const visit = (string: number) => {
      if (string === 6) {
        const voicing = evaluate(shape, required, optional, bass);
        if (voicing) {
          const key = voicing.frets.join(',');
          const existing = found.get(key);
          if (!existing || voicing.cost < existing.cost) found.set(key, voicing);
        }
        return;
      }
      for (const f of options[string]) {
        shape[string] = f;
        visit(string + 1);
      }
    };
    visit(0);
  }

  // Easiest first; then one shape per position, so the alternatives move up the neck.
  const ranked = [...found.values()].sort((a, b) => a.cost - b.cost);
  const out: GuitarVoicing[] = [];
  for (const v of ranked) {
    if (out.some((o) => Math.abs(o.position - v.position) < 2)) continue;
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function evaluate(frets: number[], required: number[], optional: number | null, bass: number): GuitarVoicing | null {
  const sounding = frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0);
  if (sounding.length < 4) return null;
  const lowest = sounding[0];
  const highest = sounding[sounding.length - 1];
  // No muted string between sounding ones.
  for (let s = lowest; s <= highest; s++) if (frets[s] < 0) return null;
  if (pitchClass(GUITAR_TUNING[lowest] + frets[lowest]) !== bass) return null;
  const present = new Set(sounding.map((s) => pitchClass(GUITAR_TUNING[s] + frets[s])));
  if (!required.every((t) => present.has(t))) return null;

  const fretted = sounding.filter((s) => frets[s] > 0);
  const min = fretted.length ? Math.min(...fretted.map((s) => frets[s])) : 0;
  const max = fretted.length ? Math.max(...fretted.map((s) => frets[s])) : 0;
  if (max - min >= SPAN) return null;
  // Open strings between fretted ones only in open position: higher up, the fingers would touch them.
  let interiorOpen = 0;
  for (let s = lowest + 1; s < highest; s++) if (frets[s] === 0) interiorOpen++;
  if (interiorOpen > 0 && max >= 4) return null;

  // Fingers: one per fretted note, or a barre at the lowest fret plus one per note above it.
  let fingers = fretted.length;
  let barre: GuitarVoicing['barre'] = null;
  const atMin = fretted.filter((s) => frets[s] === min);
  if (atMin.length >= 2) {
    const from = atMin[0];
    // A barre lies across every string from its lowest one up: none of them may be open or muted.
    let ok = true;
    for (let s = from; s <= highest; s++) if (frets[s] < min) ok = false;
    if (ok) {
      const withBarre = 1 + fretted.filter((s) => frets[s] > min).length;
      if (withBarre < fingers || fingers > 4) {
        fingers = withBarre;
        barre = { fret: min, from, to: highest };
      }
    }
  }
  if (fingers > 4) return null;
  // Two fingers on one fret (no barre) with a finger further up the neck on a string between them: the
  // hand would have to cross itself.
  const unbarred = fretted.filter((s) => !barre || frets[s] > barre.fret);
  for (const a of unbarred) {
    for (const b of unbarred) {
      if (b <= a + 1 || frets[a] !== frets[b]) continue;
      for (let s = a + 1; s < b; s++) if (frets[s] > frets[a]) return null;
    }
  }

  const muted = 6 - sounding.length;
  const open = sounding.length - fretted.length;
  const missingOptional = optional !== null && !present.has(optional) ? 1 : 0;
  const position = fretted.length ? min : 1;
  // Muted top strings are awkward; muted bass strings are normal (the bass note sits higher).
  const mutedTop = 5 - highest;
  const cost =
    0.4 * (position - 1) +
    0.5 * fingers +
    (fingers === 4 && !barre ? 0.4 : 0) +
    (barre ? 0.5 : 0) +
    0.45 * muted +
    0.6 * mutedTop -
    0.3 * open +
    0.6 * missingOptional +
    0.35 * (max - min);
  return { frets: frets.slice(), barre, fingers, position, cost };
}
