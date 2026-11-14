/**
 * Zoom and scroll of the piano roll, in sketch time. One instance is shared
 * by every track's roll so the tracks stay lined up: pinching or scrolling
 * one moves them all.
 */
export class RollViewport {
  /** Horizontal zoom (pixels per second). */
  pxPerSec = $state(80);
  /** Sketch time at the roll's left edge (seconds). */
  scrollX = $state(0);
  /** The user zoomed: stop fitting the sketch to the width. */
  userZoomed = false;
  /** Timeline length and roll width the zoom was last fitted to. */
  fittedFor = 0;
  fittedWidth = 0;
  /** Do not follow the playhead before this time (ms): the user is scrolling. */
  userScrollUntil = 0;
}
