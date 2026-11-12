import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadActivations } from '../testing/activations';
import { notesFromModelOutput } from './basicPitchCore';
import { BASIC_PITCH_SAMPLE_RATE, DEFAULT_BASIC_PITCH_PARAMS, type BasicPitchParams, type ModelOutput } from './basicPitchParams';
import { cleanupNotes, frameToSeconds, noteLevelDb, type FrameNote } from './noteCleanup';
import { HELD_NOTES } from './settings';

const params = (patch: Partial<BasicPitchParams> = {}): BasicPitchParams => ({ ...DEFAULT_BASIC_PITCH_PARAMS, ...patch });

/** Empty activations at the model's noise floor. */
function blank(frames: number): ModelOutput {
  const rows = () => Array.from({ length: frames }, () => new Array<number>(88).fill(0.1));
  return { frames: rows(), onsets: rows() };
}

/** Write a note into the activations: an onset peak (optional) and a frame plateau. */
function paint(output: ModelOutput, pitch: number, start: number, length: number, onset: number, level = 0.8) {
  const column = pitch - 21;
  for (let i = start; i < start + length; i++) output.frames[i][column] = level;
  if (onset > 0) output.onsets[start][column] = onset;
}

const note = (pitchMidi: number, startFrame: number, durationFrames: number, amplitude = 0.8): FrameNote => ({
  pitchMidi,
  startFrame,
  durationFrames,
  amplitude,
});

describe('joining held notes', () => {
  it('joins a fragment that has no onset to the note before it', () => {
    const output = blank(400);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 130, 60, 0, 0.5); // comes back after 30 frames of masking, no attack
    const { notes, report } = cleanupNotes([note(60, 20, 80), note(60, 130, 60, 0.5)], output, params());
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ pitchMidi: 60, startFrame: 20, durationFrames: 170 });
    expect(report.joined).toBe(1);
    // Mean activation over the joined length (the masked gap counts as silence).
    expect(notes[0].amplitude).toBeCloseTo((0.8 * 80 + 0.5 * 60) / 170, 5);
  });

  it('keeps a note that is struck again', () => {
    const output = blank(400);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 100, 60, 0.9);
    const { notes } = cleanupNotes([note(60, 20, 80), note(60, 100, 60)], output, params());
    expect(notes).toHaveLength(2);
  });

  it('finds the onset a couple of frames either side of the start', () => {
    const output = blank(400);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 100, 60, 0);
    output.onsets[102][39] = 0.9;
    expect(cleanupNotes([note(60, 20, 80), note(60, 100, 60)], output, params()).notes).toHaveLength(2);
  });

  it('does not bridge a gap longer than the limit, or another pitch', () => {
    const output = blank(600);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 300, 60, 0); // 200 frames (2.3 s) later
    paint(output, 62, 110, 60, 0);
    const events = [note(60, 20, 80), note(62, 110, 60), note(60, 300, 60)];
    expect(cleanupNotes(events, output, params({ joinMaxGapMs: 1500 })).notes).toHaveLength(3);
    expect(cleanupNotes(events, output, params({ joinMaxGapMs: 3000 })).notes).toHaveLength(2);
  });

  it('joins a chain of fragments into one note', () => {
    const output = blank(600);
    paint(output, 48, 10, 100, 0.9);
    const events = [note(48, 10, 100)];
    for (const start of [120, 200, 300, 380]) {
      paint(output, 48, start, 50, 0.3, 0.45);
      events.push(note(48, start, 50, 0.45));
    }
    const { notes } = cleanupNotes(events, output, params());
    expect(notes).toEqual([expect.objectContaining({ pitchMidi: 48, startFrame: 10, durationFrames: 420 })]);
  });

  it('treats a weak attack as a re-strike only in the default mode', () => {
    const output = blank(400);
    paint(output, 76, 20, 60, 0.95);
    paint(output, 76, 150, 30, 0.85, 0.45); // onset from the octave below being struck
    const events = [note(76, 20, 60), note(76, 150, 30, 0.45)];
    expect(cleanupNotes(events, output, params(HELD_NOTES.join)).notes).toHaveLength(2);
    expect(cleanupNotes(events, output, params(HELD_NOTES.strong)).notes).toHaveLength(1);
    expect(cleanupNotes(events, output, params(HELD_NOTES.off)).notes).toHaveLength(2);
  });

  it('does nothing when joining is off', () => {
    const output = blank(400);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 130, 60, 0);
    const events = [note(60, 20, 80), note(60, 130, 60)];
    expect(cleanupNotes(events, output, params({ joinHeldNotes: false })).notes).toEqual(events);
  });
});

describe('dropping what is not a piano note', () => {
  it('drops notes without a key strike, but not the tail of a held note', () => {
    const output = blank(400);
    paint(output, 60, 20, 80, 0.95);
    paint(output, 60, 130, 60, 0); // held on
    paint(output, 50, 40, 40, 0.3); // swells in: a voice, hum
    const events = [note(60, 20, 80), note(60, 130, 60), note(50, 40, 40)];
    const { notes, report } = cleanupNotes(events, output, params({ dropUnstruck: true, strikeOnset: 0.6 }));
    expect(notes.map((n) => n.pitchMidi)).toEqual([60]);
    expect(notes[0].durationFrames).toBe(170);
    expect(report.unstruck).toBe(1);
    expect(cleanupNotes(events, output, params()).notes).toHaveLength(2);
  });

  it('measures how loud a note is in the audio', () => {
    const seconds = 2;
    const samples = new Float32Array(BASIC_PITCH_SAMPLE_RATE * seconds);
    const tone = (pitch: number, gain: number) => {
      const f = 440 * 2 ** ((pitch - 69) / 12);
      for (let i = 0; i < samples.length; i++) samples[i] += gain * Math.sin((2 * Math.PI * f * i) / BASIC_PITCH_SAMPLE_RATE);
    };
    tone(60, 0.5);
    tone(67, 0.05); // 20 dB quieter
    const loud = noteLevelDb(samples, 60, 10, 60);
    expect(loud - noteLevelDb(samples, 67, 10, 60)).toBeCloseTo(20, 0);
    // A pitch that is not in the audio is well below both (bands are about a
    // semitone wide, so a loud neighbour a third away still leaks a little).
    expect(loud - noteLevelDb(samples, 64, 10, 60)).toBeGreaterThan(25);
    expect(loud - noteLevelDb(samples, 90, 10, 60)).toBeGreaterThan(50);
    // The piano's own detuning must not matter: 20 cents sharp still measures within 2 dB.
    const sharp = new Float32Array(samples.length);
    const f = 440 * 2 ** ((60.2 - 69) / 12);
    for (let i = 0; i < sharp.length; i++) sharp[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / BASIC_PITCH_SAMPLE_RATE);
    expect(Math.abs(noteLevelDb(sharp, 60, 10, 60) - loud)).toBeLessThan(2);
  });

  it('gates notes that are far quieter than the loud notes of the take', () => {
    const output = blank(400);
    const samples = new Float32Array(BASIC_PITCH_SAMPLE_RATE * 4);
    const events: FrameNote[] = [];
    const add = (pitch: number, startFrame: number, gain: number) => {
      paint(output, pitch, startFrame, 40, 0.9);
      events.push(note(pitch, startFrame, 40));
      const f = 440 * 2 ** ((pitch - 69) / 12);
      const from = Math.round(frameToSeconds(startFrame) * BASIC_PITCH_SAMPLE_RATE);
      for (let i = from; i < from + 0.45 * BASIC_PITCH_SAMPLE_RATE; i++) samples[i] += gain * Math.sin((2 * Math.PI * f * i) / BASIC_PITCH_SAMPLE_RATE);
    };
    [60, 64, 67, 72, 55].forEach((pitch, i) => add(pitch, 10 + i * 50, 0.4)); // the piano
    add(86, 20, 0.4 / 4); // 12 dB down: a soft note
    add(43, 120, 0.4 / 30); // ~30 dB down: the room
    const kept = (noiseGateDb: number | null) =>
      cleanupNotes(events, output, params({ noiseGateDb }), samples)
        .notes.map((n) => n.pitchMidi)
        .sort((a, b) => a - b);
    expect(kept(null)).toHaveLength(7);
    expect(kept(20)).toEqual([55, 60, 64, 67, 72, 86]);
    expect(kept(10)).toEqual([55, 60, 64, 67, 72]);
    // Without the audio the gate cannot run and nothing is dropped.
    expect(cleanupNotes(events, output, params({ noiseGateDb: 20 })).notes).toHaveLength(7);
  });
});

describe('on recorded activations', () => {
  const fixture = (name: string) => loadActivations(join(__dirname, 'fixtures', `${name}.activations.gz`));
  const decode = (output: ModelOutput, held: keyof typeof HELD_NOTES) =>
    notesFromModelOutput(output, params(HELD_NOTES[held]));

  it('a note held under louder chords is one note again', () => {
    const output = fixture('held-chords');
    const g3 = (held: keyof typeof HELD_NOTES) => decode(output, held).filter((n) => n.pitch === 55);

    const asDetected = g3('off');
    expect(asDetected.length).toBeGreaterThanOrEqual(4);

    const joined = g3('join');
    expect(joined.length).toBeLessThan(asDetected.length);
    expect(joined[0].startTime).toBeCloseTo(0.52, 1);

    const strong = g3('strong');
    expect(strong).toHaveLength(1);
    expect(strong[0].startTime).toBeCloseTo(0.52, 1);
    expect(strong[0].endTime).toBeGreaterThan(8);

    // The chords struck over it are untouched by the default mode.
    const others = (held: keyof typeof HELD_NOTES) =>
      decode(output, held)
        .filter((n) => n.pitch !== 55)
        .map((n) => `${n.pitch}@${n.startTime}`);
    expect(others('join')).toEqual(others('off'));
  });

  it('repeated notes stay separate', () => {
    const output = fixture('repeats');
    const count = (held: keyof typeof HELD_NOTES, pitch: number) =>
      decode(output, held).filter((n) => n.pitch === pitch).length;
    for (const held of ['off', 'join', 'strong'] as const) {
      expect(count(held, 60)).toBe(6); // detached
      expect(count(held, 55)).toBe(5); // soft legato
      // Four per second: the model itself misses one of the eight.
      expect(count(held, 72)).toBe(7);
    }
    // Legato: the six strikes stay six. (As detected, G4 also collects five
    // ghosts from the G3 an octave below; only the strong mode absorbs them.)
    expect(count('off', 67)).toBe(11);
    expect(count('join', 67)).toBe(11);
    expect(count('strong', 67)).toBe(6);
  });
});
