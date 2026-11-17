// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockPageZoom, installSpaceBar, isTextEntry, registerTransport, transportDepth } from './transport';

function key(type: 'keydown' | 'keyup', target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('the space bar', () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
    document.body.innerHTML = '';
  });

  it('plays and pauses the innermost context, and the one below once it closes', () => {
    cleanup.push(installSpaceBar());
    const canvas = vi.fn();
    const panel = vi.fn();
    cleanup.push(registerTransport(canvas));
    const closePanel = registerTransport(panel);
    key('keydown', document.body);
    expect(panel).toHaveBeenCalledTimes(1);
    expect(canvas).not.toHaveBeenCalled();
    closePanel();
    key('keydown', document.body);
    expect(canvas).toHaveBeenCalledTimes(1);
    expect(transportDepth()).toBe(1);
  });

  it('stops a focused button from also being clicked (which toggled twice)', () => {
    cleanup.push(installSpaceBar());
    const toggle = vi.fn();
    cleanup.push(registerTransport(toggle));
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    const down = key('keydown', button);
    const up = key('keyup', button);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(down.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
  });

  it('leaves spaces typed into text alone, but not sliders or checkboxes', () => {
    cleanup.push(installSpaceBar());
    const toggle = vi.fn();
    cleanup.push(registerTransport(toggle));
    const text = document.createElement('input');
    const area = document.createElement('textarea');
    const slider = Object.assign(document.createElement('input'), { type: 'range' });
    const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
    document.body.append(text, area, slider, box);
    expect(key('keydown', text).defaultPrevented).toBe(false);
    expect(key('keydown', area).defaultPrevented).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
    key('keydown', slider);
    key('keydown', box);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('ignores held repeats and modifier combinations', () => {
    cleanup.push(installSpaceBar());
    const toggle = vi.fn();
    cleanup.push(registerTransport(toggle));
    key('keydown', document.body, { repeat: true });
    key('keydown', document.body, { metaKey: true });
    key('keydown', document.body, { ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('knows what is text entry', () => {
    expect(isTextEntry(Object.assign(document.createElement('input'), { type: 'search' }))).toBe(true);
    expect(isTextEntry(Object.assign(document.createElement('input'), { type: 'range' }))).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('page zoom', () => {
  it('prevents keyboard zoom (trackpad pinches are checked in Chromium by smoke:notebook)', () => {
    const remove = blockPageZoom();
    const plus = new KeyboardEvent('keydown', { key: '=', metaKey: true, cancelable: true });
    window.dispatchEvent(plus);
    expect(plus.defaultPrevented).toBe(true);
    const typing = new KeyboardEvent('keydown', { key: '=', cancelable: true });
    window.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    remove();
  });
});
