/**
 * Styled confirmation dialog + host. Driven by `confirmStore` / `confirmDialog()`.
 * Render <ConfirmDialogHost /> once at the app root.
 */
import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useConfirmStore, type ConfirmRequest } from './confirmStore';
import './ConfirmDialog.css';

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ request, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the safe (cancel) button by default — important for destructive prompts.
    cancelRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        // Minimal focus trap across the dialog's focusable controls.
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button');
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [onCancel]);

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        // Backdrop click (not a drag from inside) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={request.message ? 'confirm-dialog-message' : undefined}
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {request.title}
        </h2>
        {request.message && (
          <p id="confirm-dialog-message" className="confirm-dialog__message">
            {request.message}
          </p>
        )}
        {request.details && <p className="confirm-dialog__details">{request.details}</p>}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`confirm-dialog__btn ${
              request.danger ? 'confirm-dialog__btn--danger' : 'confirm-dialog__btn--confirm'
            }`}
            onClick={onConfirm}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mount once at the app root — renders the active confirmation prompt. */
export function ConfirmDialogHost() {
  const current = useConfirmStore((s) => s.current);
  const resolve = useConfirmStore((s) => s._resolve);

  const onConfirm = useCallback(() => resolve(true), [resolve]);
  const onCancel = useCallback(() => resolve(false), [resolve]);

  if (!current || typeof document === 'undefined') return null;

  return createPortal(
    <ConfirmDialog key={current.id} request={current} onConfirm={onConfirm} onCancel={onCancel} />,
    document.body,
  );
}
