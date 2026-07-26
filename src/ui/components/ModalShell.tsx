/**
 * ModalShell — overlay + centered card chrome for a dialog (JP-456).
 *
 * The app had **no reusable modal component**: `DocumentPermissionsDialog`,
 * `VersionHistoryPanel`, `CloudSignInModal`, `ConfirmDialog` and
 * `MirrorResourcePicker` each hand-rolled the same overlay + card + entrance
 * keyframes, and they had drifted — z-index 1000 vs 10050 vs 10300, three
 * different backdrop tints, and (in two of them) no keyboard handling at all.
 *
 * This is the shared shell, introduced with `AccessPanel` and adopted by it
 * only. Migrating the other four is a deliberate follow-up rather than a
 * drive-by refactor of five dialogs in a feature PR.
 *
 * Provides: portal to `document.body`, backdrop dismissal (optionally blocked),
 * Escape + Tab focus trap via [[useDialogKeys]], initial focus on close, and
 * `role="dialog"` + `aria-modal` wiring.
 */

import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useDialogKeys } from './useDialogKeys';
import './ModalShell.css';

export interface ModalShellProps {
  /** Dialog title — also the accessible name. */
  title: string;
  /** Optional secondary line in the header (e.g. the document being scoped). */
  subtitle?: string | undefined;
  /** Close handler for Escape, the X button, and backdrop dismissal. */
  onClose: () => void;
  /**
   * Block backdrop-click and Escape dismissal while a flow must not be
   * abandoned mid-way. Mirrors the JP-455 rule on the sign-in modal: dismissal
   * is for terminal, actionable states only.
   */
  dismissable?: boolean;
  /** Extra class on the card, for per-dialog sizing. */
  className?: string | undefined;
  children: ReactNode;
}

export function ModalShell({
  title,
  subtitle,
  onClose,
  dismissable = true,
  className,
  children,
}: ModalShellProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useDialogKeys(cardRef, onClose, { closeOnEscape: dismissable });

  // Land focus inside the dialog on open, so a keyboard user isn't left on the
  // element behind it and the Tab trap has somewhere to start.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const handleBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Backdrop only — not a drag that started inside the card and released out.
      if (e.target !== e.currentTarget) return;
      if (!dismissable) return;
      onClose();
    },
    [dismissable, onClose],
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="modal-shell__overlay" onMouseDown={handleBackdrop}>
      <div
        ref={cardRef}
        className={`modal-shell${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="modal-shell__header">
          <div className="modal-shell__heading">
            <h2 id={titleId} className="modal-shell__title">
              {title}
            </h2>
            {subtitle ? <p className="modal-shell__subtitle">{subtitle}</p> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="modal-shell__close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="modal-shell__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export default ModalShell;
