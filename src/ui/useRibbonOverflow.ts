/**
 * The ribbon's overflow (DSK-200). In a narrow panel, such as Split, the tab's
 * groups wrap onto rows hidden under the first, and a "…" button drops those
 * rows down over the page. The first row never moves, and nothing remounts:
 * the hidden rows are the same controls, clipped.
 *
 * A click on "…" opens the rows until a second click, Escape, or a press
 * elsewhere in the app; a press inside a menu or dialog one of the controls
 * opened (they render outside the app root) leaves them open. Passing over "…"
 * does nothing, so reaching for Find beside it never drops the rows over the
 * page. Tabbing onto a hidden control opens them while focus stays in the ribbon.
 *
 * The groups that folded carry `data-folded` (and `data-row-start` where a
 * folded row begins), so the open panel can draw separators between groups, and
 * `hiddenActive` says whether a folded control applies to the selection, so "…"
 * can show that the ribbon is hiding the state of your text.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type RefObject,
} from 'react';


/** The ribbon's clusters, which wrap as whole units. */
const GROUP_SELECTOR = '.document-editor-toolbar-group';

/** A control showing that it applies to the selection, such as an active list button. */
const ACTIVE_SELECTOR = '.document-editor-toolbar-btn.active';
/** An active control in a group that folded out of the first row. */
const HIDDEN_ACTIVE_SELECTOR = `${GROUP_SELECTOR}[data-folded] ${ACTIVE_SELECTOR}`;

type OpenMode = 'focus' | 'pinned';

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
 * Mark the groups that wrapped below the first row (`data-folded`) and those that
 * begin a folded row (`data-row-start`). Returns whether any group folded.
 */
export function markFoldedGroups(strip: HTMLElement): boolean {
  const bottom = firstRowBottom(strip);
  const left = strip.getBoundingClientRect().left;
  let overflowing = false;
  for (const group of strip.querySelectorAll<HTMLElement>(GROUP_SELECTOR)) {
    const box = group.getBoundingClientRect();
    const folded = bottom !== null && box.height > 0 && box.top >= bottom - 1;
    group.toggleAttribute('data-folded', folded);
    group.toggleAttribute('data-row-start', folded && box.left - left < 2);
    overflowing ||= folded;
  }
  return overflowing;
}

/** Whether a folded group holds a control that applies to the selection. */
export function hiddenActiveIn(strip: HTMLElement): boolean {
  return strip.querySelector(HIDDEN_ACTIVE_SELECTOR) !== null;
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
  const [hiddenActive, setHiddenActive] = useState(false);
  const [mode, setMode] = useState<OpenMode | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const open = overflowing && mode !== null;

  // Measure on any size change: the panel's width, and each tab panel's own
  // height, which changes when its groups wrap differently.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const measure = () => {
      setOverflowing(markFoldedGroups(strip));
      setHiddenActive(hiddenActiveIn(strip));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const panel of Array.from(strip.children)) observer.observe(panel);
    return () => observer.disconnect();
  }, [stripRef, tabKey]);

  // Which controls are active changes with the selection, not the size: re-read
  // it after each render of the ribbon. Classes only, no layout, so it costs
  // nothing while typing.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip) setHiddenActive(hiddenActiveIn(strip));
  });

  useEffect(() => {
    setMode(null);
  }, [tabKey]);

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

  const toggle = useCallback(() => setMode((current) => (current === 'pinned' ? null : 'pinned')), []);

  const moreProps = {
    ref: moreRef,
    'aria-expanded': open,
    'data-active-hidden': (overflowing && hiddenActive) || undefined,
    onClick: toggle,
  };

  const stripProps = {
    onFocus: (event: FocusEvent) => {
      const strip = stripRef.current;
      if (mode === null && strip && overflowing && isBelowFirstRow(event.target, strip)) setMode('focus');
    },
  };

  return { overflowing, open, hiddenActive: overflowing && hiddenActive, moreProps, stripProps };
}
