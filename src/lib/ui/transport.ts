/**
 * The space bar plays and pauses whatever is in front: the canvas, an open
 * sketch, a rhythm, the rhythm panel over the canvas, a sample. Each of
 * those registers a handler while it is shown; the one registered last (the
 * innermost: a panel over the canvas) gets the key.
 *
 * One listener for the whole app, in the capture phase, so that:
 * - typing a space in a text field is never taken (only text entry: a
 *   slider, a checkbox or a focused button do not count);
 * - the default action is prevented on both key down and key up, so a
 *   focused button (the play button that was just clicked) is not also
 *   "clicked" by the space bar, which used to toggle twice and look as if
 *   play did nothing;
 * - the page never scrolls on space.
 */

type Toggle = () => void;

const handlers: { toggle: Toggle }[] = [];

/** Handle the space bar while shown. Returns the function that stops it (call it on destroy). */
export function registerTransport(toggle: Toggle): () => void {
  const entry = { toggle };
  handlers.push(entry);
  return () => {
    const index = handlers.indexOf(entry);
    if (index >= 0) handlers.splice(index, 1);
  };
}

/** How many contexts are registered (tests). */
export function transportDepth(): number {
  return handlers.length;
}

const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/** Is `el` somewhere a space is typed (a text field, a text area, editable text)? */
export function isTextEntry(el: EventTarget | Element | null): boolean {
  if (!el || !(el instanceof Element)) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has((el.getAttribute('type') ?? '').toLowerCase()) && !el.readOnly && !el.disabled;
  return !!el.closest('[contenteditable="true"], [contenteditable=""]');
}

function isSpace(e: KeyboardEvent): boolean {
  return e.key === ' ' || e.code === 'Space' || e.key === 'Spacebar';
}

/** The key event is the space bar, not typed into text, with no modifier. */
export function takesSpace(e: KeyboardEvent): boolean {
  if (!isSpace(e) || e.metaKey || e.ctrlKey || e.altKey) return false;
  return !isTextEntry(e.target) && !isTextEntry(document.activeElement);
}

/** Install the app's one space-bar listener (once, from the root component). Returns its removal. */
export function installSpaceBar(target: Window = window): () => void {
  const down = (e: KeyboardEvent) => {
    if (!takesSpace(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    handlers[handlers.length - 1]?.toggle();
  };
  const up = (e: KeyboardEvent) => {
    // A focused button activates on key up: that would be a second toggle.
    if (takesSpace(e)) e.preventDefault();
  };
  target.addEventListener('keydown', down, true);
  target.addEventListener('keyup', up, true);
  return () => {
    target.removeEventListener('keydown', down, true);
    target.removeEventListener('keyup', up, true);
  };
}

/**
 * Only the places made for zooming zoom (the canvas, a piano roll): the
 * page itself never does, by pinching, double-tapping, or a trackpad pinch
 * (which browsers send as ctrl + wheel). Those places handle their own
 * pointer and wheel events and keep working, since only the browser's
 * default (zooming the page) is prevented.
 */
export function blockPageZoom(target: Window = window): () => void {
  const doc = target.document;
  // WebKit's own pinch events (iOS, and Safari on a trackpad).
  const gesture = (e: Event) => e.preventDefault();
  // Two fingers anywhere: never the page's pinch zoom. Places that zoom use pointer events.
  const touch = (e: TouchEvent) => {
    if (e.touches.length > 1 && e.cancelable) e.preventDefault();
  };
  // A trackpad pinch arrives as ctrl + wheel; the zooming places handle it before it gets here.
  const wheel = (e: WheelEvent) => {
    if (e.ctrlKey && e.cancelable) e.preventDefault();
  };
  // Keyboard zoom (⌘/Ctrl with + − 0) would scale the whole interface.
  const key = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
  };
  doc.addEventListener('gesturestart', gesture, { passive: false });
  doc.addEventListener('gesturechange', gesture, { passive: false });
  doc.addEventListener('gestureend', gesture, { passive: false });
  doc.addEventListener('touchmove', touch, { passive: false });
  target.addEventListener('wheel', wheel, { passive: false });
  target.addEventListener('keydown', key);
  return () => {
    doc.removeEventListener('gesturestart', gesture);
    doc.removeEventListener('gesturechange', gesture);
    doc.removeEventListener('gestureend', gesture);
    doc.removeEventListener('touchmove', touch);
    target.removeEventListener('wheel', wheel);
    target.removeEventListener('keydown', key);
  };
}
