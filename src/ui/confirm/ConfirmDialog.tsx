/**
 * Styled confirmation + prompt dialog host. Driven by `confirmStore` /
 * `confirmDialog()` / `promptDialog()`. Render <ConfirmDialogHost /> once at the
 * app root.
 */
import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useConfirmStore, type ConfirmRequest, type PromptRequest } from './confirmStore';
import './ConfirmDialog.css';

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Minimal focus trap across the dialog's focusable controls (buttons + inputs). */
function useDialogKeys(
  dialogRef: RefObject<HTMLElement>,
  onCancel: () => void,
): void {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>('button, input');
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
  }, [dialogRef, onCancel]);
}

function ConfirmDialog({ request, onConfirm, onCancel }: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Focus the safe (cancel) button by default — important for destructive prompts.
    cancelRef.current?.focus();
  }, []);
  useDialogKeys(dialogRef, onCancel);

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
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

interface PromptDialogProps {
  request: PromptRequest;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function PromptDialog({ request, onSubmit, onCancel }: PromptDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(request.initialValue ?? '');

  useEffect(() => {
    // Focus + select the input so the user can type or overwrite immediately.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useDialogKeys(dialogRef, onCancel);

  const trimmed = value.trim();
  const submit = () => {
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  };

  return (
    <div
      className="confirm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={request.message ? 'confirm-dialog-message' : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {request.title}
        </h2>
        {request.message && (
          <p id="confirm-dialog-message" className="confirm-dialog__message">
            {request.message}
          </p>
        )}
        <input
          ref={inputRef}
          type="text"
          className="confirm-dialog__input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={request.placeholder}
          aria-label={request.label ?? request.title}
        />
        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="confirm-dialog__btn confirm-dialog__btn--cancel"
            onClick={onCancel}
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="submit"
            className="confirm-dialog__btn confirm-dialog__btn--confirm"
            disabled={trimmed.length === 0}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Mount once at the app root — renders the active confirmation / prompt dialog. */
export function ConfirmDialogHost() {
  const current = useConfirmStore((s) => s.current);
  const resolve = useConfirmStore((s) => s._resolve);

  const onConfirm = useCallback(() => resolve(true), [resolve]);
  const onCancel = useCallback(() => resolve(false), [resolve]);
  const onPromptCancel = useCallback(() => resolve(null), [resolve]);
  const onPromptSubmit = useCallback((value: string) => resolve(value), [resolve]);

  if (!current || typeof document === 'undefined') return null;

  return createPortal(
    current.kind === 'prompt' ? (
      <PromptDialog
        key={current.id}
        request={current}
        onSubmit={onPromptSubmit}
        onCancel={onPromptCancel}
      />
    ) : (
      <ConfirmDialog key={current.id} request={current} onConfirm={onConfirm} onCancel={onCancel} />
    ),
    document.body,
  );
}
