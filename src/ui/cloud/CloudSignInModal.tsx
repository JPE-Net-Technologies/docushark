/**
 * Cloud sign-in modal — overlay + centered card chrome around
 * <CloudConnectPanel/>. Mirrors `confirm/ConfirmDialog` (portal mount lives in
 * <CloudSignInHost/>), but the focus trap is widened beyond buttons because the
 * panel also has inputs, links, and a `<details>` disclosure.
 */
import { useEffect, useRef } from 'react';
import { Cloud, X } from 'lucide-react';
import { CloudConnectPanel } from './CloudConnectPanel';
import './CloudSignInModal.css';

/** Focusable controls inside the modal — wider than ConfirmDialog's button-only
 *  trap (inputs / links / the Advanced `<summary>`). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

interface CloudSignInModalProps {
  onClose: () => void;
}

export function CloudSignInModal({ onClose }: CloudSignInModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
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
  }, [onClose]);

  return (
    <div
      className="cloud-signin-overlay"
      onMouseDown={(e) => {
        // Backdrop click (not a drag from inside) dismisses.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="cloud-signin-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-signin-title"
      >
        <header className="cloud-signin-modal__head">
          <h2 id="cloud-signin-title" className="cloud-signin-modal__title">
            <Cloud size={18} aria-hidden="true" />
            DocuShark Cloud
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="cloud-signin-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <CloudConnectPanel onClose={onClose} />
      </div>
    </div>
  );
}

export default CloudSignInModal;
