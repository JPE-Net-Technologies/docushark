/**
 * Cloud sign-in modal — overlay + centered card chrome around
 * <CloudConnectPanel/>. Mirrors `confirm/ConfirmDialog` (portal mount lives in
 * <CloudSignInHost/>), but the focus trap is widened beyond buttons because the
 * panel also has inputs, links, and a `<details>` disclosure.
 *
 * While a device-code sign-in is pending (the panel reports busy via
 * `onBusyChange`), a backdrop click does NOT dismiss — an accidental click-out
 * mid-authorization used to cancel the whole flow (JP-420). The blocked click
 * is acknowledged with a brief card pulse and focus moves to the panel's
 * Cancel, so stopping remains one explicit action away (Escape and the X
 * button also still work).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, X } from 'lucide-react';
import { CloudConnectPanel } from './CloudConnectPanel';
import bannerUrl from '../../assets/cloud-signin-banner.webp';
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
  const [panelBusy, setPanelBusy] = useState(false);
  // Non-zero while the "blocked backdrop click" pulse animation plays; reset on
  // animation end so a later blocked click can re-trigger it.
  const [pulsing, setPulsing] = useState(false);

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

  const handleBackdropMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Backdrop click only (not a drag from inside the card).
      if (e.target !== e.currentTarget) return;
      if (!panelBusy) {
        onClose();
        return;
      }
      // Blocked: acknowledge instead of going inert — pulse the card and land
      // focus on the in-flow Cancel (fall back to the X button).
      setPulsing(true);
      const cancel = dialogRef.current?.querySelector<HTMLElement>(
        '.cloud-connect__device .cloud-connect__btn--secondary',
      );
      (cancel ?? closeRef.current)?.focus();
    },
    [panelBusy, onClose],
  );

  return (
    <div className="cloud-signin-overlay" onMouseDown={handleBackdropMouseDown}>
      <div
        ref={dialogRef}
        className={`cloud-signin-modal${pulsing ? ' cloud-signin-modal--pulse' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-signin-title"
        onAnimationEnd={() => setPulsing(false)}
      >
        {/* Decorative brand hero (the web banner) with a scrim that fades into
            the card background, so the overlaid title reads in both themes. */}
        <header
          className="cloud-signin-modal__hero"
          style={{ backgroundImage: `url(${bannerUrl})` }}
        >
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
        <CloudConnectPanel onClose={onClose} onBusyChange={setPanelBusy} />
      </div>
    </div>
  );
}

export default CloudSignInModal;
