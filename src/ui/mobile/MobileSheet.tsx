/**
 * MobileSheet — a reusable full-screen sheet for the mobile preview (JP-332).
 *
 * A presentational overlay shell: a fixed, full-viewport panel (portaled to
 * `document.body` so no editor-layout ancestor can clip or mis-stack it) with a
 * safe-area-aware header (title + Done) and a scrollable body slot. Dismissal is
 * the caller's Done handler plus Escape.
 *
 * It sits at a modest z-index (above the editor chrome, below the picker portals
 * and the confirm-dialog host) so panel-owned popovers — the property panel's
 * color/icon/pattern pickers, which portal to `document.body` at a higher
 * z-index — render *over* the sheet and stay interactive. Because the sheet
 * never installs an outside-click/focus trap, those `[data-flyout-keep-open]`
 * portals need no special-casing here.
 *
 * Slice 3 uses it for the full-screen property panel; Slice 4's prose toolbar
 * sheet composes the same primitive.
 */

import { ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './MobileSheet.css';

export interface MobileSheetProps {
  /** Header title + ARIA label. */
  title: string;
  /** Called by the Done button and Escape. */
  onClose: () => void;
  /** Sheet body. */
  children: ReactNode;
  /** Extra class on the sheet root for per-use styling. */
  className?: string;
}

export function MobileSheet({ title, onClose, children, className }: MobileSheetProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
