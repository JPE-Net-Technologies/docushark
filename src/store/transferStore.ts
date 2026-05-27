/**
 * Transfer Store
 *
 * Surfaces the progress of an in-flight document transfer (Local ↔ Cloud)
 * into shared state so the UI can show the phase and block concurrent
 * transfers. `DocumentTransferService` owns the two-phase-commit logic and
 * already rejects overlapping transfers; this store mirrors its `onProgress`
 * callbacks so React components don't have to thread the callback themselves.
 *
 * JP-83.
 */

import { create } from 'zustand';
import type { TransferDirection, TransferState } from '../services/DocumentTransferService';

interface TransferStoreState {
  /** Current transfer phase, or `'idle'` when none is running. */
  phase: TransferState;
  /** Document id being transferred (null when idle). */
  docId: string | null;
  /** Direction of the active/last transfer. */
  direction: TransferDirection | null;
  /** Error from the last failed transfer (cleared on the next `begin`). */
  error: string | null;
}

interface TransferStoreActions {
  /** Mark a transfer as starting; clears any prior error. */
  begin: (docId: string, direction: TransferDirection) => void;
  /** Mirror a `DocumentTransferService` progress callback. */
  setPhase: (phase: TransferState) => void;
  /** Record a terminal failure (leaves `error` visible until next `begin`). */
  fail: (error: string) => void;
  /** Return to the idle state. */
  reset: () => void;
}

const initialState: TransferStoreState = {
  phase: 'idle',
  docId: null,
  direction: null,
  error: null,
};

export const useTransferStore = create<TransferStoreState & TransferStoreActions>()((set) => ({
  ...initialState,
  begin: (docId, direction) => set({ phase: 'preparing', docId, direction, error: null }),
  setPhase: (phase) => set({ phase }),
  fail: (error) => set({ phase: 'failed', error }),
  reset: () => set(initialState),
}));

/** Phases where a transfer is still running (UI should block new transfers). */
export function isTransferRunning(phase: TransferState): boolean {
  return phase !== 'idle' && phase !== 'committed' && phase !== 'rolled-back' && phase !== 'failed';
}

/** Human-readable label for a transfer phase (for inline progress UI). */
export function transferPhaseLabel(direction: TransferDirection | null, phase: TransferState): string {
  const target = direction === 'to-personal' ? 'Personal' : 'Relay';
  switch (phase) {
    case 'preparing':
    case 'prepared':
      return `Preparing move to ${target}…`;
    case 'executing':
      return `Moving to ${target}…`;
    case 'committing':
      return `Finishing move to ${target}…`;
    case 'rolling-back':
      return 'Rolling back…';
    default:
      return '';
  }
}
