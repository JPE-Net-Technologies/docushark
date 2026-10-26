/**
 * MobileSheet — a reusable sheet for the mobile preview (JP-332).
 *
 * A presentational overlay shell, portaled to `document.body` so no
 * editor-layout ancestor can clip or mis-stack it, with a safe-area-aware
 * header and a scrollable body slot. Two placements:
 *
 * - `full` (default): a full-viewport panel with a title and Done. It sits at a
 *   modest z-index (above the editor chrome, below the picker portals and the
 *   confirm-dialog host) so panel-owned popovers — the property panel's
 *   color/icon/pattern pickers, which portal to `document.body` at a higher
 *   z-index — render *over* the sheet and stay interactive. Because the sheet
 *   never installs an outside-click/focus trap, those `[data-flyout-keep-open]`
 *   portals need no special-casing here.
 * - `bottom` (DSK-196): an action sheet that rises from the bottom edge over a
 *   scrim, sized to its content. It replaces a dropdown on touch, so it sits on
 *   the dropdown layer (above the Documents surface). Tapping the scrim, the
 *   close button, Escape, or swiping the header down dismisses it. Clicks
 *   inside never reach the React tree it was opened from: a document card opens
 *   on click and renames on double-click, and a tap on its sheet must do
 *   neither.
 *
 * Dismissal is always the caller's `onClose`.
 */

import { ReactNode, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, X } from 'lucide-react';
import './MobileSheet.css';

export interface MobileSheetProps {
  /** Header title + ARIA label. */
  title: string;
  /** Called by Done (or the close button), Escape, the scrim and a swipe down. */
  onClose: () => void;
  /** Sheet body. */
  children: ReactNode;
  /** Extra class on the sheet root for per-use styling. */
  className?: string;
  /** `full` (default) covers the viewport; `bottom` is an action sheet. */
  placement?: 'full' | 'bottom' | undefined;
  /** A line under the title — for an action sheet, what the actions apply to. */
  subtitle?: string | undefined;
  /** Shows a back control before the title (an action sheet's second page). */
  onBack?: (() => void) | undefined;
}

/**
 * A header drag dismisses when it travels far enough, or is a flick: fast, and
 * long enough not to be a tap's jitter (a few pixels in a few milliseconds is
 * "fast" too).
 */
const SWIPE_DISMISS_DISTANCE = 80;
const SWIPE_FLICK_VELOCITY = 0.5; // px/ms
const SWIPE_FLICK_MIN_DISTANCE = 24;

export function MobileSheet({
  title,
  onClose,
  children,
  className,
  placement = 'full',
  subtitle,
  onBack,
}: MobileSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (placement === 'bottom') {
    return (
      <BottomSheet title={title} subtitle={subtitle} onBack={onBack} onClose={onClose} className={className}>
        {children}
      </BottomSheet>
    );
  }

  return createPortal(
    <div
      className={`mobile-sheet${className ? ` ${className}` : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className="mobile-sheet-header">
        <span className="mobile-sheet-title">{title}</span>
        <button type="button" className="mobile-sheet-done" onClick={onClose}>
          Done
        </button>
      </header>
      <div className="mobile-sheet-body">{children}</div>
    </div>,
    document.body,
  );
}

interface BottomSheetProps {
  title: string;
  subtitle: string | undefined;
  onBack: (() => void) | undefined;
  onClose: () => void;
  className: string | undefined;
  children: ReactNode;
}

function BottomSheet({ title, subtitle, onBack, onClose, className, children }: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startTime: number; dy: number } | null>(null);

  // The sheet is a modal dialog: take focus so a screen reader lands in it and
  // a hardware keyboard's Escape reaches us. preventScroll: the panel is fixed,
  // and focusing must not scroll whatever lies underneath.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    // Buttons in the header (back, close) keep their own clicks; capturing the
    // pointer here would retarget the click to the header.
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startTime: e.timeStamp, dy: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || d.pointerId !== e.pointerId || !panel) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    panel.style.transition = 'none';
    panel.style.transform = d.dy > 0 ? `translateY(${d.dy}px)` : '';
  };

  const endDrag = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    const elapsed = Math.max(1, e.timeStamp - d.startTime);
    const flick = d.dy >= SWIPE_FLICK_MIN_DISTANCE && d.dy / elapsed >= SWIPE_FLICK_VELOCITY;
    const dismiss = !cancelled && (d.dy >= SWIPE_DISMISS_DISTANCE || flick);
    if (panel) {
      panel.style.transition = '';
      if (!dismiss) panel.style.transform = '';
    }
    if (dismiss) onClose();
  };

  // Stop React-tree propagation at the layer: the sheet is portaled to <body>,
  // but synthetic events still bubble to the component that rendered it.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return createPortal(
    <div className="mobile-sheet-layer" onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
      <div className="mobile-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`mobile-sheet mobile-sheet--bottom${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header
          className="mobile-sheet-header mobile-sheet-header--bottom"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
        >
          <span className="mobile-sheet-grip" aria-hidden="true" />
          {onBack && (
            <button type="button" className="mobile-sheet-icon-btn" onClick={onBack} aria-label="Back">
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
          )}
          <span className="mobile-sheet-heading">
            <span className="mobile-sheet-title">{title}</span>
            {subtitle && <span className="mobile-sheet-subtitle">{subtitle}</span>}
          </span>
          <button type="button" className="mobile-sheet-icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="mobile-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
