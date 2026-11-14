/**
 * Browser-preview demo data (`npm run dev`, open `/?demo`): an audio sketch
 * with a 40-second, many-chord progression, rendered with the built-in
 * synth, plus its "transcription". Used to work on the UI without recording.
 * Never used inside the Tauri app.
 */
import { ANALYSIS_SAMPLE_RATE } from '../audio/analysisAudio';
import type { SketchLibrary } from '../library/types';
import { summarize } from '../music/summary';
import { renderNotesToWav } from '../music/synth';
import type { PianoNote } from '../transcription/types';

const PROGRESSION: [number, number[]][] = [
  [36, [60, 64, 67]],
  [45, [60, 64, 69]],
  [41, [60, 65, 69]],
  [43, [59, 62, 67]],
  [40, [59, 64, 67]],
  [45, [60, 64, 69]],
  [38, [60, 65, 69]],
  [43, [59, 62, 65]],
  [36, [59, 64, 67]],
  [33, [61, 64, 67]],
  [38, [62, 65, 69]],
  [41, [60, 65, 68]],
  [40, [60, 64, 67]],
  [39, [60, 63, 66]],
  [38, [60, 65, 69]],
  [43, [59, 62, 65]],
];

export function demoNotes(): PianoNote[] {
  const notes: PianoNote[] = [];
  const bar = 2.5;
  PROGRESSION.forEach(([bass, triad], i) => {
    const t = 0.4 + i * bar;
    notes.push({ pitch: bass, startTime: t, endTime: t + bar - 0.1, velocity: 70, confidence: 0.85 });
    for (const pitch of triad) notes.push({ pitch, startTime: t, endTime: t + bar - 0.15, velocity: 62, confidence: 0.75 });
    // A little melody on top.
    [0, 0.625, 1.25, 1.875].forEach((offset, k) => {
      const pitch = triad[k % 3] + 12;
      notes.push({ pitch, startTime: t + offset, endTime: t + offset + 0.5, velocity: 85, confidence: 0.9 });
    });
  });
  return notes;
}

/** A second part for the demo's two-track sketch: a slow line in the bass and tenor. */
export function demoSecondPart(): PianoNote[] {
  const notes: PianoNote[] = [];
  PROGRESSION.forEach(([bass], i) => {
    const t = 0.4 + i * 2.5;
    notes.push({ pitch: bass + 12, startTime: t + 1.25, endTime: t + 2.3, velocity: 75, confidence: 0.9 });
    notes.push({ pitch: bass + 19, startTime: t + 1.875, endTime: t + 2.4, velocity: 70, confidence: 0.8 });
  });
  return notes;
}

/**
 * `?demo`: one sketch. `?demo=tracks`: the same sketch with a second track
 * (whose recording starts 1.5 s into the first).
 */
export async function seedDemo(library: SketchLibrary, options: { tracks?: number } = {}): Promise<void> {
  const notes = demoNotes();
  const created = await library.create({
    mediaExtension: 'wav',
    mediaMime: 'audio/wav',
    captureBackend: 'demo',
    title: 'Demo: sixteen bars',
  });
  const take = await renderNotesToWav(notes, { sampleRate: 44100 });
  await library.writeFile(created.id, 'media-chunk', take);
  await library.finalize({
    id: created.id,
    durationMs: Math.round((0.4 + PROGRESSION.length * 2.5 + 1.5) * 1000),
    hasVideo: false,
    videoWidth: null,
    videoHeight: null,
  });
  await library.writeFile(created.id, 'analysis', await renderNotesToWav(notes, { sampleRate: ANALYSIS_SAMPLE_RATE }));
  await library.saveTranscription({
    id: created.id,
    engine: 'demo',
    engineVersion: '1',
    params: {},
    notes,
    summary: summarize(notes),
  });
  if ((options.tracks ?? 1) < 2) return;

  // Track 2: recorded "later", starting 1.5 s into the sketch.
  const offset = 1.5;
  const part = demoSecondPart().map((n) => ({ ...n, startTime: n.startTime - offset, endTime: n.endTime - offset }));
  const second = await library.create({
    mediaExtension: 'wav',
    mediaMime: 'audio/wav',
    captureBackend: 'demo',
    parentId: created.id,
  });
  await library.writeFile(second.id, 'media-chunk', await renderNotesToWav(part, { sampleRate: 44100 }));
  await library.finalize({
    id: second.id,
    durationMs: Math.round((part.reduce((t, n) => Math.max(t, n.endTime), 0) + 1.5) * 1000),
    hasVideo: false,
    videoWidth: null,
    videoHeight: null,
    offsetMs: offset * 1000,
  });
  await library.writeFile(second.id, 'analysis', await renderNotesToWav(part, { sampleRate: ANALYSIS_SAMPLE_RATE }));
  await library.saveTranscription({
    id: second.id,
    engine: 'demo',
    engineVersion: '1',
    params: {},
    notes: part,
    summary: summarize(part),
  });
}
