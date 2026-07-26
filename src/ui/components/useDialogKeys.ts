/**
 * Escape-to-close + Tab focus trap for a modal dialog (JP-456).
 *
 * This logic previously existed in three independent copies — `ConfirmDialog`
 * (selector `'button, input'`), `CloudSignInModal` (a wider selector, to cover
 * links and a `<details>` summary), and `FlyoutPanel` (a third selector, on
 * `window` rather than `document`) — each re-deriving first/last focusable and
 * the wrap-around. Meanwhile `DocumentPermissionsDialog` and
 * `VersionHistoryPanel` had **neither**: no Escape, no trap, backdrop click only.
 *
 * The selector here is the widest of the three, so a dialog containing links,
 * selects, or a disclosure traps correctly without each caller inventing its own.
 */

import { useEffect, type RefObject } from 'react';

/**
 * Everything focusable a dialog body might realistically contain. Disabled
 * controls and `tabindex="-1"` are excluded — they are not tab stops, and
 * treating them as the first/last element would trap focus on an inert node.
 */
export const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export interface DialogKeysOptions {
  /** Set false for a dialog that must be dismissed deliberately. Default true. */
  closeOnEscape?: boolean;
}

/**
 * Wire Escape + Tab cycling for the dialog rooted at `ref`.
 *
 * Listens on `document` in the **capture** phase so a dialog rendered over an
 * editor surface wins the key before a canvas/prose handler can swallow it.
 */
export function useDialogKeys(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  options: DialogKeysOptions = {},
): void {
  const closeOnEscape = options.closeOnEscape ?? true;

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (!closeOnEscape) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = ref.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE);
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
    };

    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [ref, onClose, closeOnEscape]);
}
