/**
 * Imperative styled-dialog utility — a drop-in replacement for the gross vanilla
 * `window.confirm` / `window.prompt`. Call `await confirmDialog({...})` (yes/no →
 * `Promise<boolean>`) or `await promptDialog({...})` (text input →
 * `Promise<string | null>`) from anywhere (event handlers, hooks, stores); a
 * single `<ConfirmDialogHost />` mounted at the app root renders the styled
 * dialog. Both kinds share one queue + host so concurrent requests serialize.
 *
 * Customizable per call: title, message, an extra `details` line (confirm only),
 * button labels, a `danger` (destructive) treatment (confirm only), and an input
 * label/placeholder/initial value (prompt only).
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

export interface PromptOptions {
  /** Bold heading. */
  title: string;
  /** Optional explanatory line above the input. */
  message?: string;
  /** Accessible label for the text field. */
  label?: string;
  /** Input placeholder. */
  placeholder?: string;
  /** Pre-filled value (e.g. the current name when renaming). */
  initialValue?: string;
  /** Confirm button label (default "OK"). */
  confirmLabel?: string;
  /** Cancel button label (default "Cancel"). */
  cancelLabel?: string;
}

interface DialogRequestBase {
  id: string;
  /** Internal resolver — narrowed by the wrapper so callers get a clean type. */
  resolve: (result: boolean | string | null) => void;
}

export interface ConfirmRequest extends ConfirmOptions, DialogRequestBase {
  kind: 'confirm';
}

export interface PromptRequest extends PromptOptions, DialogRequestBase {
  kind: 'prompt';
}

export type DialogRequest = ConfirmRequest | PromptRequest;

interface ConfirmState {
  current: DialogRequest | null;
  queue: DialogRequest[];
  /** @internal */ _enqueue: (req: DialogRequest) => void;
  /** @internal */ _resolve: (result: boolean | string | null) => void;
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
  _resolve: (result) => {
    const { current, queue } = get();
    current?.resolve(result);
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
    useConfirmStore.getState()._enqueue({
      ...opts,
      kind: 'confirm',
      id: `confirm-${seq}`,
      resolve: (r) => resolve(r === true),
    });
  });
}

/**
 * Show a styled single-line text prompt. Resolves the trimmed input on confirm,
 * or `null` on cancel / Esc / backdrop dismiss / empty. Requires
 * `<ConfirmDialogHost />` mounted once.
 */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    seq += 1;
    useConfirmStore.getState()._enqueue({
      ...opts,
      kind: 'prompt',
      id: `prompt-${seq}`,
      resolve: (r) => resolve(typeof r === 'string' && r.length > 0 ? r : null),
    });
  });
}
