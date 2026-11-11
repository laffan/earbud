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

export async function seedDemo(library: SketchLibrary): Promise<void> {
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
}
