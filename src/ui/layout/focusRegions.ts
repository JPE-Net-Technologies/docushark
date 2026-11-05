/**
 * Moving keyboard focus between the editor's regions (DSK-214): the top bar,
 * the text and the canvas. F6 and Shift+F6 cycle through the regions on
 * screen, as in other desktop apps. In a browser tab the browser keeps F6 for
 * itself, so the palette's "Move focus to the canvas" and "Move focus to the
 * text" reach the two surfaces too. The region that receives focus shows a
 * brief ring, so the jump can be seen.
 *
 * Regions mark themselves with `data-focus-region`. The canvas registers how
 * it takes focus: its keyboard shortcuts only reach it while it has focus.
 */

export type FocusRegion = 'topbar' | 'prose' | 'canvas';

/** How long the receiving region's ring shows. */
export const ARRIVAL_RING_MS = 700;

/** The text editor's editable surface, which takes focus for the prose region. */
const PROSE_SURFACE = '.ProseMirror[contenteditable="true"]';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

let canvasFocus: (() => void) | null = null;

/** The canvas registers how it takes focus; returns the unregister. */
export function registerCanvasFocus(focus: () => void): () => void {
  canvasFocus = focus;
  return () => {
    if (canvasFocus === focus) canvasFocus = null;
  };
}

/** Give keyboard focus back to the canvas. False when no canvas is mounted. */
export function focusCanvas(): boolean {
  if (!canvasFocus) return false;
  canvasFocus();
  return true;
}

/** The regions on screen, in document order (a hidden one has no boxes). */
function shownRegions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-focus-region]')).filter(
    (region) => region.getClientRects().length > 0,
  );
}

/** Whether `region` is on screen now. */
export function isRegionShown(region: FocusRegion): boolean {
  return shownRegions().some((element) => element.dataset['focusRegion'] === region);
}

const ringTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Focus a region's natural target, and ring it briefly. */
function enter(element: HTMLElement): void {
  const region = element.dataset['focusRegion'] as FocusRegion;
  if (region === 'canvas' && focusCanvas()) {
    // The canvas took focus through its registration.
  } else {
    const target =
      (region === 'prose' ? element.querySelector<HTMLElement>(PROSE_SURFACE) : null) ??
      element.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }
  const pending = ringTimers.get(element);
  if (pending) clearTimeout(pending);
  element.dataset['focusArrived'] = '';
  ringTimers.set(
    element,
    setTimeout(() => {
      delete element.dataset['focusArrived'];
      ringTimers.delete(element);
    }, ARRIVAL_RING_MS),
  );
}

/** F6 (1) and Shift+F6 (-1): move focus to the next or previous region on screen. */
export function cycleFocusRegion(direction: 1 | -1): void {
  const regions = shownRegions();
  if (regions.length === 0) return;
  const current = regions.findIndex((region) => region.contains(document.activeElement));
  // From outside every region, F6 enters the first and Shift+F6 the last.
  const from = current >= 0 ? current : direction === 1 ? -1 : 0;
  enter(regions[(from + direction + regions.length) % regions.length]!);
}

/** Move focus to one surface, if it is on screen. */
export function focusRegion(region: FocusRegion): boolean {
  const element = shownRegions().find((candidate) => candidate.dataset['focusRegion'] === region);
  if (!element) return false;
  enter(element);
  return true;
}
