import { describe, expect, it } from 'vitest';
import type { Sketch } from '../library/types';
import { emptyPattern } from '../music/rhythm';
import { canvasNoteRects, clampView, fitView, MAX_PPS, rulerStep, sketchSpan, zoomAround } from './canvasGeometry';

function sketch(patch: Partial<Sketch>): Sketch {
  return {
    id: 'a'.repeat(32),
    title: '',
    createdAt: 0,
    updatedAt: 0,
    status: 'saved',
    durationMs: 10_000,
    mediaPath: null,
    mediaMime: null,
    hasVideo: false,
    videoWidth: null,
    videoHeight: null,
    analysisPath: null,
    textNotes: '',
    transcriptionStatus: 'done',
    transcriptionError: null,
    captureBackend: 'test',
    recovered: false,
    summary: null,
    hasEdits: false,
    listenMode: 'recording',
    cropStartMs: null,
    cropEndMs: null,
    parentId: null,
    trackId: null,
    offsetMs: 0,
    countInMs: null,
    tempoBpm: null,
    beatMs: null,
    tempoSource: null,
    notebookId: 'n'.repeat(32),
    canvasXMs: 0,
    canvasY: 0,
    kind: 'audio',
    rhythm: null,
    canvasRepeats: 1,
    canvasVolume: 1,
    noteSampleId: null,
    canvasW: null,
    canvasH: null,
    ...patch,
  };
}

describe('sketchSpan', () => {
  it('starts a recording at its downbeat, which sits where it was placed', () => {
    // Recorded with a 2 s count-in: time 0 lies 2 s before the press at 5 s.
    const span = sketchSpan(sketch({ canvasXMs: 3000, countInMs: 2000, durationMs: 9000 }));
    expect(span).toEqual({ origin: 3, from: 2, to: 9, start: 5, end: 12, cycle: 7, repeats: 1 });
  });

  it('plays only the crop, and uses the decoded length once known', () => {
    const span = sketchSpan(sketch({ canvasXMs: 1000, countInMs: 2000, cropStartMs: 3000, cropEndMs: 6000 }), 8.5);
    expect([span.start, span.end]).toEqual([4, 7]);
    expect(sketchSpan(sketch({ canvasXMs: 0 }), 8.5).end).toBe(8.5);
  });

  it('plays a recording several times in a row', () => {
    const span = sketchSpan(sketch({ canvasXMs: 1000, countInMs: 1000, cropEndMs: 4000, canvasRepeats: 3 }), 8);
    // Its part is 1–4 s of the recording (3 s), three times from 2 s.
    expect([span.start, span.end, span.cycle, span.repeats]).toEqual([2, 11, 3, 3]);
  });

  it('gives a rhythm its length on the canvas', () => {
    const rhythm = { ...emptyPattern(120, 1), lengthBars: 3 };
    const span = sketchSpan(sketch({ kind: 'rhythm', rhythm, canvasXMs: 500 }));
    expect([span.start, span.end]).toEqual([0.5, 6.5]);
  });

  it('draws a recording of unknown length as a short block', () => {
    const span = sketchSpan(sketch({ durationMs: null, canvasXMs: 2000 }));
    expect(span.end - span.start).toBe(1);
  });
});

describe('the view', () => {
  it('zooms around the point under the fingers', () => {
    const view = { scrollX: 10, scrollY: 0, pps: 20 };
    const zoomed = zoomAround(view, 2, 200);
    // 200 px in was 20 s and still is.
    expect(zoomed.pps).toBe(40);
    expect(zoomed.scrollX + 200 / zoomed.pps).toBeCloseTo(20, 9);
    expect(zoomAround(view, 1e6, 0).pps).toBe(MAX_PPS);
  });

  it('does not scroll far before time 0 or above the top', () => {
    const view = clampView({ scrollX: -100, scrollY: -500, pps: 24 });
    expect(view.scrollX).toBe(-2);
    expect(view.scrollY).toBe(-48);
  });

  it('fits every sketch in the width', () => {
    const view = fitView(
      [
        { start: 2, end: 12, y: 40 },
        { start: 30, end: 42, y: 300 },
      ],
      400,
      600,
    );
    const left = view.scrollX * view.pps;
    expect(2 * view.pps - left).toBeGreaterThan(0);
    expect(42 * view.pps - left).toBeLessThanOrEqual(400);
  });

  it('labels the ruler at a readable spacing', () => {
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(20)).toBe(5);
    expect(rulerStep(2)).toBe(60);
  });
});

describe('canvas notes preview', () => {
  it('clips notes to the crop and viewport and shows the same notes in each repeat', () => {
    const span = sketchSpan(sketch({ cropStartMs: 1000, cropEndMs: 3000, canvasRepeats: 3 }));
    const notes = [
      { pitch: 60, startTime: 0.5, endTime: 1.5, velocity: 80 },
      { pitch: 72, startTime: 2.5, endTime: 3.5, velocity: 80 },
      { pitch: 80, startTime: 4, endTime: 5, velocity: 80 },
    ];
    const rects = canvasNoteRects(notes, span, 100, 25, 425);
    expect(rects.map((r) => [r.x, r.width, r.repeat])).toEqual([
      [0, 25, 0], [125, 50, 0], [175, 50, 1], [325, 50, 1], [375, 25, 2],
    ]);
    expect(rects[0].y).toBeGreaterThan(rects[1].y);
    expect(rects.every((r) => r.x >= 0 && r.x + r.width <= 400 && r.y >= 0 && r.y + r.height <= 36)).toBe(true);
  });

  it('leaves an empty transcription empty', () => {
    expect(canvasNoteRects([], sketchSpan(sketch({})), 100, 0, 200)).toEqual([]);
  });
});
