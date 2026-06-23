/**
 * Cloud sign-in modal visibility — a tiny zustand toggle, mirroring the
 * `confirmStore` pattern so any surface (the Documents workspace chip, the
 * connection banner's Reconnect, a `docushark:open-cloud-connect` event) can
 * pop the Cloud connect modal without prop-drilling or a view switch.
 *
 * A single `<CloudSignInHost />` mounted at the app root renders the modal
 * (portaled to `document.body`) when `isOpen`.
 */
import { create } from 'zustand';

interface CloudSignInState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useCloudSignInStore = create<CloudSignInState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

/**
 * Imperatively open the Cloud sign-in modal from anywhere (event handlers,
 * stores, notification actions) — the `confirmDialog()` analogue. Requires a
 * `<CloudSignInHost />` mounted once at the app root.
 */
export function openCloudSignIn(): void {
  useCloudSignInStore.getState().open();
}
