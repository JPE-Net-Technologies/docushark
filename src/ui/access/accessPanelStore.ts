/**
 * Access panel visibility + scope — a small zustand toggle mirroring
 * `cloudSignInStore`, so any surface (a document card, the workspace chip, the
 * Cloud panel) can open access management without prop-drilling or a view switch.
 *
 * A single `<AccessPanelHost />` at the app root renders the panel when open.
 */
import { create } from 'zustand';

/**
 * Which rung of the ladder the panel opens on. `collection` is deliberately
 * absent until collections carry grants — the rung renders as a placeholder so
 * the shape is visible, but nothing can target it yet.
 */
export type AccessScope = 'document' | 'workspace';

export interface AccessPanelTarget {
  scope: AccessScope;
  /** Required for `document` scope; ignored otherwise. */
  documentId?: string | null;
  /** A step to bring into view on open: `publish`, from Share → Publish a link (DSK-257). */
  focus?: 'publish' | null;
}

interface AccessPanelState {
  isOpen: boolean;
  scope: AccessScope;
  documentId: string | null;
  focus: 'publish' | null;
  open: (target: AccessPanelTarget) => void;
  close: () => void;
}

export const useAccessPanelStore = create<AccessPanelState>((set) => ({
  isOpen: false,
  scope: 'workspace',
  documentId: null,
  focus: null,
  open: ({ scope, documentId, focus }) =>
    set({ isOpen: true, scope, documentId: documentId ?? null, focus: focus ?? null }),
  close: () => set({ isOpen: false }),
}));

/**
 * Imperatively open access management — the `confirmDialog()` analogue.
 * Requires an `<AccessPanelHost />` mounted once at the app root.
 */
export function openAccessPanel(target: AccessPanelTarget): void {
  useAccessPanelStore.getState().open(target);
}
