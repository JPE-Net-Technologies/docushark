/**
 * Toolbar tooltips (DSK-217). One layer, mounted once, shows a tooltip for any
 * control that carries `tip()`'s attributes: its name and shortcut on one line,
 * and, for a less familiar control, one sentence under them saying what it does.
 *
 * It replaces the browser's `title` tooltips on the toolbars, which appear late,
 * vanish on keyboard focus, and can't explain a control.
 *
 * - A tooltip appears after the pointer rests on a control, and at once while
 *   moving along a bar (one hid moments ago), so neighbours read quickly.
 * - Keyboard focus shows it too, but not the focus a click leaves behind.
 * - Touch never does: a tap is a press.
 * - Escape, a press, scrolling and resizing put it away, and a control whose
 *   menu is open (aria-expanded) shows none over it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';
import './TooltipLayer.css';

/** How long the pointer rests on a control before its tooltip shows. */
export const REST_MS = 400;
/** For this long after a tooltip hides, the next one shows at once. */
export const WARM_MS = 600;

/** Gap between the control and its tooltip, and the margin kept from the window's edges. */
const GAP = 8;

/** The attributes that give a control its tooltip: spread them onto the control. */
export function tip(name: string, keys?: string, description?: string): Record<string, string> {
  return {
    'data-tip': name,
    ...(keys ? { 'data-tip-keys': keys } : {}),
    ...(description ? { 'data-tip-description': description } : {}),
  };
}

interface Shown {
  target: HTMLElement;
  name: string;
  keys: string | undefined;
  description: string | undefined;
}

/** The control a node belongs to, if it has a tooltip. */
function tipTarget(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null;
}

/** Keyboard focus, as opposed to the focus a click leaves on a button. */
function focusIsVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true; // an engine without :focus-visible
  }
}

/** Below the control, or above it when the window has no room below. */
function placeBelowOrAbove(rect: DOMRect): CSSProperties {
  const below = rect.bottom + GAP + 48 <= window.innerHeight;
  return {
    position: 'fixed',
    left: rect.left + rect.width / 2,
    top: below ? rect.bottom + GAP : rect.top - GAP,
    transform: below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
  };
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let lastHidden = -Infinity;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const show = (target: HTMLElement) => {
      cancel();
      // A control whose menu is open keeps it clear.
      if (target.getAttribute('aria-expanded') === 'true') return;
      current = target;
      setShown({
        target,
        name: target.dataset['tip'] ?? '',
        keys: target.dataset['tipKeys'],
        description: target.dataset['tipDescription'],
      });
    };
    const hide = () => {
      cancel();
      if (current) lastHidden = Date.now();
      current = null;
      setShown(null);
    };
    // Shows after a rest, or at once while warm.
    const request = (target: HTMLElement) => {
      if (target === current) return;
      if (current || Date.now() - lastHidden < WARM_MS) {
        show(target);
        return;
      }
      cancel();
      timer = setTimeout(() => show(target), REST_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (current && !current.isConnected) hide();
      const target = tipTarget(event.target);
      if (target) request(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tipTarget(event.target);
      if (!target || target.contains(event.relatedTarget as Node | null)) return;
      if (target === current) hide();
      else cancel();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tipTarget(event.target);
      if (target && focusIsVisible(event.target as Element)) show(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (current && current.contains(event.target as Node)) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && current) hide();
    };

    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      cancel();
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  // Keep it inside the window: shift it sideways once its width is known.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const box = popup.getBoundingClientRect();
    const overflowRight = box.right - (window.innerWidth - GAP);
    const overflowLeft = GAP - box.left;
    if (overflowRight > 0) popup.style.marginLeft = `${-overflowRight}px`;
    else if (overflowLeft > 0) popup.style.marginLeft = `${overflowLeft}px`;
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={popupRef}
      className={`ds-tooltip ds-tooltip--rich${shown.description ? ' ds-tooltip--described' : ''}`}
      role="tooltip"
      style={placeBelowOrAbove(shown.target.getBoundingClientRect())}
    >
      <div className="ds-tooltip__line">
        <span className="ds-tooltip__name">{shown.name}</span>
        {shown.keys && <kbd className="ds-tooltip__keys">{shown.keys}</kbd>}
      </div>
      {shown.description && <div className="ds-tooltip__description">{shown.description}</div>}
    </div>,
    document.body,
  );
}
