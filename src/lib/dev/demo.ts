/**
 * Browser-preview demo data (`npm run dev`, open `/?demo`): a notebook with
 * piano sketches (a 40-second, many-chord progression and parts that go with
 * it, rendered with the built-in synth, with their "transcriptions") and a
 * rhythm. Used to work on the UI without recording. Never used inside the
 * Tauri app.
 */
import { ANALYSIS_SAMPLE_RATE } from '../audio/analysisAudio';
import type { SketchLibrary } from '../library/types';
import { notesEndTime } from '../music/notes';
import { emptyPattern, playSeconds } from '../music/rhythm';
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

/** A third part: an arpeggiated line in the treble, one chord tone every eighth note. */
export function demoThirdPart(): PianoNote[] {
  const notes: PianoNote[] = [];
  PROGRESSION.forEach(([, triad], i) => {
    const t = 0.4 + i * 2.5;
    for (let k = 0; k < 8; k++) {
      const pitch = triad[k % 3] + 24;
      notes.push({ pitch, startTime: t + k * 0.3125, endTime: t + k * 0.3125 + 0.28, velocity: 64, confidence: 0.8 });
    }
  });
  return notes;
}

/**
 * `?demo`: a notebook with three piano sketches and a rhythm. The 16-bar
 * piece (a bar every 2.5 s, so 96 BPM) sits over a rhythm stretched to
 * the same length; its bass and tenor line is a separate sketch further
 * down, starting four bars in; the treble arpeggio comes later on, past the
 * first screen, to show the canvas going on.
 */
export async function seedDemoNotebook(library: SketchLibrary): Promise<void> {
  const notebook = await library.createNotebook('Demo notebook');
  const place = (x: number, y: number) => ({ notebookId: notebook.id, canvasXMs: Math.round(x * 1000), canvasY: y });
  // The piece's first chord is 0.4 s into its recording: it lands at 2 s.
  await addDemoSketch(library, 'Sixteen bars', demoNotes(), place(1.6, 40));
  const fourBars = 4 * 2.5;
  const laterPart = demoSecondPart()
    .filter((n) => n.startTime >= fourBars)
    .map((n) => ({ ...n, startTime: n.startTime - fourBars, endTime: n.endTime - fourBars }));
  await addDemoSketch(library, 'Bass and tenor', laterPart, place(1.6 + fourBars, 330));
  await addDemoSketch(library, 'Arpeggio', demoThirdPart().slice(0, 64), place(52, 120));
  const beat = emptyPattern(96, 1);
  for (const s of [0, 8]) beat.pads[0][s] = 1;
  for (const s of [4, 12]) beat.pads[1][s] = 1;
  for (let s = 0; s < 16; s += 2) beat.pads[2][s] = 1;
  const rhythm = { ...beat, lengthBars: 16 };
  await library.createRhythm({
    ...place(2, 210),
    title: 'Backbeat',
    rhythm,
    durationMs: Math.round(playSeconds(rhythm) * 1000),
  });
}

/** A piano sketch whose recording is `notes` rendered by the synth, with them as its transcription. */
async function addDemoSketch(
  library: SketchLibrary,
  title: string,
  notes: PianoNote[],
  place: { notebookId: string; canvasXMs: number; canvasY: number },
) {
  const created = await library.create({ mediaExtension: 'wav', mediaMime: 'audio/wav', captureBackend: 'demo', title, ...place });
  await library.writeFile(created.id, 'media-chunk', await renderNotesToWav(notes, { sampleRate: 44100 }));
  await library.finalize({
    id: created.id,
    durationMs: Math.round((notesEndTime(notes) + 1.5) * 1000),
    hasVideo: false,
    videoWidth: null,
    videoHeight: null,
  });
  await library.writeFile(created.id, 'analysis', await renderNotesToWav(notes, { sampleRate: ANALYSIS_SAMPLE_RATE }));
  await library.saveTranscription({ id: created.id, engine: 'demo', engineVersion: '1', params: {}, notes, summary: summarize(notes) });
}
