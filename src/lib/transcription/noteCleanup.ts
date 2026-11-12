/**
 * Piano-specific clean-up of Basic Pitch's note events.
 *
 * Basic Pitch is instrument-agnostic: any pitched sound becomes a note, and a
 * note is cut whenever its activation dips or another onset appears. For a
 * piano recorded in a room that causes two problems, handled here:
 *
 *  1. Held notes break into fragments. While other notes are struck over a
 *     held one, its frame activation dips below the threshold (masking), and
 *     the remaining stretches come back as separate notes. A piano note
 *     cannot start without an attack, so a fragment that has no real onset
 *     and follows a note of the same pitch is that note still sounding:
 *     `joinHeldNotes` stitches it back on.
 *  2. Background sounds become notes. Voices, hum and bumps produce frame
 *     activations too, but usually without a piano-like onset and at a much
 *     lower level than the instrument next to the microphone. `dropUnstruck`
 *     removes notes that were never struck, and the level gate removes notes
 *     that are far quieter than the loud notes of the take.
 *
 * Everything works on the decoder's frame indices (not on rounded seconds),
 * because onset activations are only a few frames wide.
 */
import { BASIC_PITCH_SAMPLE_RATE, type BasicPitchParams, type ModelOutput } from './basicPitchParams';

/** A note as the decoder reports it: frame indices, MIDI pitch, mean activation. */
export interface FrameNote {
  startFrame: number;
  durationFrames: number;
  pitchMidi: number;
  amplitude: number;
}

/** What the clean-up measured for one note (exposed for tests and tuning). */
export interface NoteEvidence {
  /** Peak of the model's onset activation around the note's start (0–1). */
  onset: number;
  /** Peak frame activation in the first ~140 ms (0–1). */
  attack: number;
  /** Level of the note's partials in the audio at its attack (dB, arbitrary reference). */
  levelDb?: number;
}

export type CleanupParams = Pick<
  BasicPitchParams,
  'joinHeldNotes' | 'joinMaxGapMs' | 'restrikeOnset' | 'restrikeAttack' | 'strikeOnset' | 'dropUnstruck' | 'noiseGateDb'
>;

export interface CleanupReport {
  /** Fragments that were stitched onto an earlier note. */
  joined: number;
  /** Notes dropped because they had no attack. */
  unstruck: number;
  /** Notes dropped by the level gate. */
  quiet: number;
}

const MIDI_OFFSET = 21;
const FFT_HOP = 256;
const FRAMES_PER_WINDOW = Math.floor(BASIC_PITCH_SAMPLE_RATE / FFT_HOP) * 2;
const SAMPLES_PER_WINDOW = BASIC_PITCH_SAMPLE_RATE * 2 - FFT_HOP;
/** Same constant as basic-pitch-ts: each 2 s window starts slightly early. */
const WINDOW_OFFSET =
  (FFT_HOP / BASIC_PITCH_SAMPLE_RATE) * (FRAMES_PER_WINDOW - SAMPLES_PER_WINDOW / FFT_HOP) + 0.0018;

/** Seconds from the start of the audio for a model frame (as in basic-pitch-ts). */
export function frameToSeconds(frame: number): number {
  return (frame * FFT_HOP) / BASIC_PITCH_SAMPLE_RATE - WINDOW_OFFSET * Math.floor(frame / FRAMES_PER_WINDOW);
}

/** Frames to look at on either side of a note's start for its onset peak. */
const ONSET_REACH = 2;
/** Frames after the start in which the attack is measured (~140 ms). */
const ATTACK_FRAMES = 12;

function onsetPeak(output: ModelOutput, column: number, frame: number): number {
  let peak = 0;
  const to = Math.min(output.onsets.length - 1, frame + ONSET_REACH);
  for (let i = Math.max(0, frame - ONSET_REACH); i <= to; i++) peak = Math.max(peak, output.onsets[i][column]);
  return peak;
}

function attackPeak(output: ModelOutput, column: number, frame: number): number {
  let peak = 0;
  const to = Math.min(output.frames.length - 1, frame + ATTACK_FRAMES);
  for (let i = Math.max(0, frame); i <= to; i++) peak = Math.max(peak, output.frames[i][column]);
  return peak;
}

/** Power of `samples[from, from + length)` at `frequency` (Goertzel), per sample. */
function bandPower(samples: Float32Array, from: number, length: number, frequency: number): number {
  const w = (2 * Math.PI * frequency) / BASIC_PITCH_SAMPLE_RATE;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    // Hann window keeps a loud neighbouring note from leaking into this band.
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    const s0 = samples[from + i] * window + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
  return power / (length * length);
}

/**
 * How loud a note is in the recording: the strongest of its first three
 * partials during the attack, in dB. Bands are about a semitone wide so a
 * slightly out-of-tune piano still lands in them. Low notes are measured
 * mostly by their upper partials, which is what a phone microphone records.
 */
export function noteLevelDb(samples: Float32Array, pitchMidi: number, startFrame: number, durationFrames: number): number {
  const f0 = 440 * 2 ** ((pitchMidi - 69) / 12);
  const start = Math.max(0, Math.round(frameToSeconds(startFrame) * BASIC_PITCH_SAMPLE_RATE));
  const span = Math.round(Math.min(0.25, Math.max(0.06, (durationFrames * FFT_HOP) / BASIC_PITCH_SAMPLE_RATE)) * BASIC_PITCH_SAMPLE_RATE);
  let best = 0;
  for (let partial = 1; partial <= 3; partial++) {
    const frequency = f0 * partial;
    if (frequency > BASIC_PITCH_SAMPLE_RATE * 0.45) break;
    // ~12 cycles: roughly a semitone of bandwidth.
    const length = Math.max(128, Math.min(4096, Math.round((12 * BASIC_PITCH_SAMPLE_RATE) / frequency)));
    const hop = Math.max(64, length >> 1);
    for (let from = start; from < start + span && from + length <= samples.length; from += hop) {
      best = Math.max(best, bandPower(samples, from, length, frequency));
    }
  }
  return 10 * Math.log10(best + 1e-12);
}

/** The level a "loud note of this take" has: the 80th percentile of struck notes. */
function referenceLevel(levels: number[]): number {
  if (levels.length === 0) return -Infinity;
  const sorted = [...levels].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
}

export function measureNote(output: ModelOutput, note: FrameNote, samples?: Float32Array): NoteEvidence {
  const column = note.pitchMidi - MIDI_OFFSET;
  const evidence: NoteEvidence = {
    onset: onsetPeak(output, column, note.startFrame),
    attack: attackPeak(output, column, note.startFrame),
  };
  if (samples) evidence.levelDb = noteLevelDb(samples, note.pitchMidi, note.startFrame, note.durationFrames);
  return evidence;
}

/**
 * Join held-note fragments, then drop notes that are not piano strikes.
 * `samples` (the 22.05 kHz analysis audio) is only needed for the level gate.
 */
export function cleanupNotes(
  events: readonly FrameNote[],
  output: ModelOutput,
  params: CleanupParams,
  samples?: Float32Array,
): { notes: FrameNote[]; report: CleanupReport } {
  const report: CleanupReport = { joined: 0, unstruck: 0, quiet: 0 };
  const framesPerSecond = BASIC_PITCH_SAMPLE_RATE / FFT_HOP;
  const maxGap = Math.round((params.joinMaxGapMs / 1000) * framesPerSecond);

  interface Candidate {
    note: FrameNote;
    evidence: NoteEvidence;
    struck: boolean;
    /** Sum of activation × frames, to keep `amplitude` a mean after joining. */
    weight: number;
  }

  const byPitch = new Map<number, Candidate[]>();
  for (const event of events) {
    const evidence = measureNote(output, event);
    const candidate: Candidate = {
      note: { ...event },
      evidence,
      struck: evidence.onset >= params.strikeOnset,
      weight: event.amplitude * event.durationFrames,
    };
    const list = byPitch.get(event.pitchMidi);
    if (list) list.push(candidate);
    else byPitch.set(event.pitchMidi, [candidate]);
  }

  const kept: Candidate[] = [];
  for (const list of byPitch.values()) {
    list.sort((a, b) => a.note.startFrame - b.note.startFrame);
    let head: Candidate | null = null;
    for (const next of list) {
      if (head && params.joinHeldNotes) {
        const headEnd = head.note.startFrame + head.note.durationFrames;
        const gap = next.note.startFrame - headEnd;
        // A new strike of a key needs both a clear onset and the jump in
        // activation that comes with it. Without them, sound at the same pitch
        // shortly after a note is that note, still held.
        const restruck =
          next.evidence.onset >= params.restrikeOnset && next.evidence.attack >= params.restrikeAttack;
        if (gap <= maxGap && !restruck) {
          const end = Math.max(headEnd, next.note.startFrame + next.note.durationFrames);
          head.note.durationFrames = end - head.note.startFrame;
          head.weight += next.weight;
          head.note.amplitude = head.weight / head.note.durationFrames;
          report.joined++;
          continue;
        }
      }
      head = next;
      kept.push(next);
    }
  }

  let result = kept;
  if (params.dropUnstruck) {
    const before = result.length;
    result = result.filter((c) => c.struck);
    report.unstruck = before - result.length;
  }

  if (samples && params.noiseGateDb !== null && result.length > 0) {
    for (const c of result) {
      c.evidence.levelDb = noteLevelDb(samples, c.note.pitchMidi, c.note.startFrame, c.note.durationFrames);
    }
    const struck = result.filter((c) => c.struck);
    const reference = referenceLevel((struck.length > 0 ? struck : result).map((c) => c.evidence.levelDb!));
    const floor = reference - Math.abs(params.noiseGateDb);
    const before = result.length;
    result = result.filter((c) => c.evidence.levelDb! >= floor);
    report.quiet = before - result.length;
  }

  return { notes: result.map((c) => c.note), report };
}
