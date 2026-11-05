/**
 * The ribbon's overflow (DSK-200). In a narrow panel, such as Split, the tab's
 * groups wrap onto rows hidden under the first, and a "…" button drops those
 * rows down over the page. The first row never moves, and nothing remounts:
 * the hidden rows are the same controls, clipped.
 *
 * Resting the pointer on "…" opens the rows, and leaving them closes them
 * after a grace period. A click pins them open until a second click, Escape,
 * or a press elsewhere in the app; a press inside a menu or dialog one of the
 * controls opened (they render outside the app root) leaves them open.
 * Tabbing onto a hidden control opens them while focus stays in the ribbon.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

/** How long the pointer rests on "…" before the rows open. */
export const HOVER_OPEN_MS = 150;
/** How long the rows stay open after the pointer leaves them. */
export const HOVER_CLOSE_MS = 250;

/** The ribbon's clusters, which wrap as whole units. */
const GROUP_SELECTOR = '.document-editor-toolbar-group';

type OpenMode = 'hover' | 'focus' | 'pinned';

/** The bottom of the first row: the first laid-out group's (a hidden tab's have no size). */
function firstRowBottom(strip: HTMLElement): number | null {
  for (const group of strip.querySelectorAll<HTMLElement>(GROUP_SELECTOR)) {
    const box = group.getBoundingClientRect();
    if (box.height > 0) return box.bottom;
  }
  return null;
}

/** Whether `element` sits on a row below the strip's first. */
export function isBelowFirstRow(element: Element, strip: HTMLElement): boolean {
  const bottom = firstRowBottom(strip);
  return bottom !== null && element.getBoundingClientRect().top >= bottom - 1;
}

/** Whether any of the strip's groups wrapped below its first row. */
export function wrapsPastFirstRow(strip: HTMLElement): boolean {
  const bottom = firstRowBottom(strip);
  if (bottom === null) return false;
  for (const group of strip.querySelectorAll<HTMLElement>(GROUP_SELECTOR)) {
    const box = group.getBoundingClientRect();
    if (box.height > 0 && box.top >= bottom - 1) return true;
  }
  return false;
}

/**
 * @param stripRef The element holding the tab panels, clipped to one row.
 * @param toolbarRef The whole ribbon: presses inside it never close the rows.
 * @param tabKey The active tab: a new tab is measured afresh and starts closed.
 */
export function useRibbonOverflow(
  stripRef: RefObject<HTMLElement>,
  toolbarRef: RefObject<HTMLElement>,
  tabKey: unknown,
) {
  const [overflowing, setOverflowing] = useState(false);
  const [mode, setMode] = useState<OpenMode | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = overflowing && mode !== null;

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  // Measure on any size change: the panel's width, and each tab panel's own
  // height, which changes when its groups wrap differently.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => setOverflowing(wrapsPastFirstRow(strip));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const panel of Array.from(strip.children)) observer.observe(panel);
    return () => observer.disconnect();
  }, [stripRef, tabKey]);

  useEffect(() => {
    setMode(null);
  }, [tabKey]);

  useEffect(() => clearTimer, [clearTimer]);

  // While open, Escape and presses elsewhere in the app close the rows.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Focus on a control that is about to be clipped moves to "…".
      if (stripRef.current?.contains(document.activeElement)) moreRef.current?.focus();
      setMode(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (toolbarRef.current?.contains(target)) return;
      if (!document.getElementById('root')?.contains(target)) return;
      setMode(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, stripRef, toolbarRef]);

  // Opened by keyboard focus: closed again when focus leaves the ribbon.
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (mode !== 'focus' || !toolbar) return undefined;
    const onFocusOut = (event: globalThis.FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (!(next && toolbar.contains(next))) setMode(null);
    };
    toolbar.addEventListener('focusout', onFocusOut);
    return () => toolbar.removeEventListener('focusout', onFocusOut);
  }, [mode, toolbarRef]);

  const closeAfterGrace = useCallback(() => {
    clearTimer();
    timer.current = setTimeout(() => setMode((current) => (current === 'hover' ? null : current)), HOVER_CLOSE_MS);
  }, [clearTimer]);

  // Hover belongs to a mouse or a pen: a touch press fires these events too,
  // then a click.
  const moreProps = {
    ref: moreRef,
    'aria-expanded': open,
    onClick: () => {
      clearTimer();
      setMode((current) => (current === 'pinned' ? null : 'pinned'));
    },
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType === 'touch') return;
      clearTimer();
      if (mode === null) timer.current = setTimeout(() => setMode('hover'), HOVER_OPEN_MS);
    },
    onPointerLeave: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'touch') closeAfterGrace();
    },
  };

  const stripProps = {
    onPointerEnter: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'touch') clearTimer();
    },
    onPointerLeave: (event: ReactPointerEvent) => {
      if (event.pointerType !== 'touch') closeAfterGrace();
    },
    onFocus: (event: FocusEvent) => {
      const strip = stripRef.current;
      if (mode === null && strip && overflowing && isBelowFirstRow(event.target, strip)) setMode('focus');
    },
  };

  return { overflowing, open, moreProps, stripProps };
}
