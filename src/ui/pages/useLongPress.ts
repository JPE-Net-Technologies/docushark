/**
 * Press and hold (DSK-260). On touch, holding a page's tab opens its menu, as
 * a right-click does with a mouse; Safari on an iPhone or iPad never turns a
 * long press into a right-click, so without this a finger can't reach the
 * page's actions at all.
 *
 * Moving first (to scroll the strip, or to drag the tab) cancels the hold, and
 * the click that ends a hold doesn't also open the page. One instance serves a
 * whole strip: the handlers read the pressed element from the event.
 */

import { useCallback, useEffect, useRef } from 'react';

/** How long a finger must rest before the menu opens. */
export const LONG_PRESS_MS = 480;
/** How far it may drift before the press counts as a scroll or a drag. */
export const LONG_PRESS_SLOP_PX = 8;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void;
}

export function useLongPress(onHold: (point: { x: number; y: number }, target: HTMLElement) => void): LongPressHandlers {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const held = useRef(false);
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;

  const cancel = useCallback(() => {
    if (press.current) {
      clearTimeout(press.current.timer);
      press.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      held.current = false;
      cancel();
      // A mouse has a right-click; this is for fingers and pens.
      if (e.pointerType === 'mouse') return;
      const target = e.currentTarget;
      const point = { x: e.clientX, y: e.clientY };
      press.current = {
        ...point,
        timer: setTimeout(() => {
          press.current = null;
          held.current = true;
          onHoldRef.current(point, target);
        }, LONG_PRESS_MS),
      };
    },
    [cancel],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancel();
    },
    [cancel],
  );

  const onClickCapture = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!held.current) return;
    held.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp: cancel, onPointerCancel: cancel, onClickCapture };
}
