/**
 * Imperative styled-confirmation utility — a drop-in replacement for the gross
 * vanilla `window.confirm`. Call `await confirmDialog({...})` from anywhere
 * (event handlers, hooks, stores) and get back a `Promise<boolean>`; a single
 * `<ConfirmDialogHost />` mounted at the app root renders the styled dialog.
 *
 * Customizable per call: title, message, an extra `details` line (e.g. exactly
 * what happens to a relay doc online vs offline), button labels, and a `danger`
 * (destructive) treatment. Concurrent requests queue.
 */
import { create } from 'zustand';

export interface ConfirmOptions {
  /** Bold heading — the question. */
  title: string;
  /** Primary explanatory line. */
  message?: string;
  /** Secondary line for consequences/behavior (e.g. "kept in Trash for 7 days"). */
  details?: string;
  /** Confirm button label (default "Confirm"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
  /** Destructive (red) confirm button — for deletes/removals. */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  id: string;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmState {
  current: ConfirmRequest | null;
  queue: ConfirmRequest[];
  /** @internal */ _enqueue: (req: ConfirmRequest) => void;
  /** @internal */ _resolve: (confirmed: boolean) => void;
}

let seq = 0;

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  queue: [],
  _enqueue: (req) => {
    const { current, queue } = get();
    if (current) set({ queue: [...queue, req] });
    else set({ current: req });
  },
  _resolve: (confirmed) => {
    const { current, queue } = get();
    current?.resolve(confirmed);
    const [next, ...rest] = queue;
    set({ current: next ?? null, queue: rest });
  },
}));

/**
 * Show a styled confirmation prompt. Resolves `true` on confirm, `false` on
 * cancel / Esc / backdrop dismiss. Requires `<ConfirmDialogHost />` mounted once.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    seq += 1;
    useConfirmStore.getState()._enqueue({ ...opts, id: `confirm-${seq}`, resolve });
  });
}
