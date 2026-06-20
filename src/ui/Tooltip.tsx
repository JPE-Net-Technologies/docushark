/**
 * Tooltip — a small reusable, app-styled hover/focus tooltip.
 *
 * Wraps a single trigger element and shows a styled popup on hover or keyboard
 * focus. The popup is **portaled to `document.body` with fixed positioning** so
 * it is never clipped by an ancestor `overflow: hidden` (e.g. the canvas pane
 * that hosts the relaxed split divider). The trigger is cloned (not wrapped in
 * an extra DOM box) so it keeps its own layout/positioning — handlers are
 * composed with any the child already declares.
 *
 * Prefer this over native `title=""` when the tooltip should match app styling.
 */

import {
  Children,
  cloneElement,
  type FocusEvent as ReactFocusEvent,
  isValidElement,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right';

/** Gap (px) between the trigger and the tooltip. */
const GAP = 8;

interface TriggerHandlers {
  onMouseEnter?: (e: ReactMouseEvent) => void;
  onMouseLeave?: (e: ReactMouseEvent) => void;
  onFocus?: (e: ReactFocusEvent) => void;
  onBlur?: (e: ReactFocusEvent) => void;
}

export interface TooltipProps {
  /** Tooltip body — text or nodes. When nullish, the tooltip is disabled. */
  content: ReactNode;
  /** Side of the trigger the tooltip appears on (default: top). */
  placement?: TooltipPlacement;
  /** The single trigger element (cloned to attach hover/focus handlers). */
  children: ReactElement<TriggerHandlers>;
}

function call(handler: ((e: never) => void) | undefined, e: unknown): void {
  handler?.(e as never);
}

function popupStyle(rect: DOMRect, placement: TooltipPlacement): React.CSSProperties {
  switch (placement) {
    case 'bottom':
      return { top: rect.bottom + GAP, left: rect.left + rect.width / 2, transform: 'translate(-50%, 0)' };
    case 'left':
      return { top: rect.top + rect.height / 2, left: rect.left - GAP, transform: 'translate(-100%, -50%)' };
    case 'right':
      return { top: rect.top + rect.height / 2, left: rect.right + GAP, transform: 'translate(0, -50%)' };
    case 'top':
    default:
      return { top: rect.top - GAP, left: rect.left + rect.width / 2, transform: 'translate(-50%, -100%)' };
  }
}

export function Tooltip({ content, placement = 'top', children }: TooltipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  const child = Children.only(children);
  const childProps: TriggerHandlers = isValidElement(child) ? child.props : {};

  const show = useCallback((e: ReactMouseEvent | ReactFocusEvent) => {
    setRect(e.currentTarget.getBoundingClientRect());
  }, []);
  const hide = useCallback(() => setRect(null), []);

  const cloned = cloneElement(child, {
    onMouseEnter: (e: ReactMouseEvent) => {
      call(childProps.onMouseEnter, e);
      show(e);
    },
    onMouseLeave: (e: ReactMouseEvent) => {
      call(childProps.onMouseLeave, e);
      hide();
    },
    onFocus: (e: ReactFocusEvent) => {
      call(childProps.onFocus, e);
      show(e);
    },
    onBlur: (e: ReactFocusEvent) => {
      call(childProps.onBlur, e);
      hide();
    },
  });

  return (
    <>
      {cloned}
      {rect != null &&
        content != null &&
        content !== false &&
        createPortal(
          <div className="ds-tooltip" role="tooltip" style={{ position: 'fixed', ...popupStyle(rect, placement) }}>
            {content}
          </div>,
          document.body
        )}
    </>
  );
}

export default Tooltip;
