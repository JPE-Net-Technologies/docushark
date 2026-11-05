/**
 * Moving keyboard focus between the regions (DSK-214): F6 and Shift+F6 cycle
 * the top bar, the text and the canvas on screen, the canvas takes focus
 * through its registration, and the receiving region rings briefly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ARRIVAL_RING_MS,
  cycleFocusRegion,
  focusCanvas,
  focusRegion,
  isRegionShown,
  registerCanvasFocus,
} from './focusRegions';
import { dispatchKey } from '../../engine/CommandRegistry';

let canvas: HTMLCanvasElement;
let unregister: () => void;
/** Regions the test hides (display: none leaves an element no boxes). */
const hidden = new Set<string>();

beforeEach(() => {
  // jsdom can't focus a bare contenteditable; the browser can. tabindex stands in.
  document.body.innerHTML = `
    <div data-focus-region="topbar"><button>Documents</button></div>
    <div data-focus-region="prose"><button>Undo</button><div class="ProseMirror" contenteditable="true" tabindex="0">text</div></div>
    <div data-focus-region="canvas"><button>Select</button><canvas tabindex="0"></canvas></div>
    <button id="outside">outside</button>`;
  canvas = document.querySelector('canvas')!;
  unregister = registerCanvasFocus(() => canvas.focus());
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const region = (this as HTMLElement).dataset['focusRegion'];
    return (region && hidden.has(region) ? [] : [{}]) as unknown as DOMRectList;
  });
});

afterEach(() => {
  unregister();
  hidden.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** The region holding focus. */
const focused = () =>
  (document.activeElement?.closest('[data-focus-region]') as HTMLElement | null)?.dataset['focusRegion'];
const regionElement = (name: string) => document.querySelector<HTMLElement>(`[data-focus-region="${name}"]`)!;

describe('moving focus between regions (DSK-214)', () => {
  it('F6 cycles the top bar, the text and the canvas, and Shift+F6 goes back', () => {
    document.getElementById('outside')!.focus();
    cycleFocusRegion(1);
    expect(focused()).toBe('topbar');
    cycleFocusRegion(1);
    expect(document.activeElement).toBe(document.querySelector('.ProseMirror'));
    cycleFocusRegion(1);
    expect(document.activeElement).toBe(canvas);
    cycleFocusRegion(1);
    expect(focused()).toBe('topbar');
    cycleFocusRegion(-1);
    expect(document.activeElement).toBe(canvas);
  });

  it('from outside every region, Shift+F6 enters the last one', () => {
    document.getElementById('outside')!.focus();
    cycleFocusRegion(-1);
    expect(document.activeElement).toBe(canvas);
  });

  it('skips a region that is not on screen', () => {
    hidden.add('canvas');
    regionElement('prose').querySelector<HTMLElement>('.ProseMirror')!.focus();
    cycleFocusRegion(1);
    expect(focused()).toBe('topbar');
    expect(isRegionShown('canvas')).toBe(false);
    expect(focusRegion('canvas')).toBe(false);
    expect(isRegionShown('prose')).toBe(true);
  });

  it('moves to one surface on request', () => {
    expect(focusRegion('prose')).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.ProseMirror'));
    expect(focusRegion('canvas')).toBe(true);
    expect(document.activeElement).toBe(canvas);
  });

  it('the canvas takes focus through its registration, and without one nothing happens', () => {
    expect(focusCanvas()).toBe(true);
    expect(document.activeElement).toBe(canvas);
    unregister();
    document.getElementById('outside')!.focus();
    expect(focusCanvas()).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('outside'));
  });

  it('F6 and Shift+F6 reach it through the global key commands, even while typing', () => {
    document.querySelector<HTMLElement>('.ProseMirror')!.focus();
    expect(dispatchKey(new KeyboardEvent('keydown', { key: 'F6' }), 'global')).toBe(true);
    expect(document.activeElement).toBe(canvas);
    expect(dispatchKey(new KeyboardEvent('keydown', { key: 'F6', shiftKey: true }), 'global')).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.ProseMirror'));
  });

  it('rings the receiving region briefly', () => {
    vi.useFakeTimers();
    focusRegion('canvas');
    expect(regionElement('canvas').hasAttribute('data-focus-arrived')).toBe(true);
    vi.advanceTimersByTime(ARRIVAL_RING_MS - 1);
    expect(regionElement('canvas').hasAttribute('data-focus-arrived')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(regionElement('canvas').hasAttribute('data-focus-arrived')).toBe(false);
  });
});
