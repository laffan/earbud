import { describe, expect, it } from 'vitest';
import type { Sketch } from '../library/types';
import { emptyPattern } from '../music/rhythm';
import { clampView, fitView, MAX_PPS, rulerStep, sketchSpan, zoomAround } from './canvasGeometry';

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
    ...patch,
  };
}

describe('sketchSpan', () => {
  it('starts a recording at its downbeat, which sits where it was placed', () => {
    // Recorded with a 2 s count-in: time 0 lies 2 s before the press at 5 s.
    const span = sketchSpan(sketch({ canvasXMs: 3000, countInMs: 2000, durationMs: 9000 }));
    expect(span).toEqual({ origin: 3, from: 2, to: 9, start: 5, end: 12 });
  });

  it('plays only the crop, and uses the decoded length once known', () => {
    const span = sketchSpan(sketch({ canvasXMs: 1000, countInMs: 2000, cropStartMs: 3000, cropEndMs: 6000 }), 8.5);
    expect([span.start, span.end]).toEqual([4, 7]);
    expect(sketchSpan(sketch({ canvasXMs: 0 }), 8.5).end).toBe(8.5);
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
