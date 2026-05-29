import { create } from 'zustand';
import type { BlobSyncProgress } from '../collaboration/BlobSyncService';

/**
 * Transient UI state for relay asset uploads (JP-126). Fed by `BlobSyncService`
 * progress events during `saveToHost`; read by `UploadIndicator`. File-count
 * granularity — per-byte progress within a file is a follow-up (needs an XHR
 * upload transport; `fetch` has no upload-progress events).
 */
interface UploadStatusState {
  active: boolean;
  phase: BlobSyncProgress['phase'] | null;
  current: number;
  total: number;
  /** Record a progress event from the blob sync service. */
  report: (progress: BlobSyncProgress) => void;
  /** Reset to idle once a save's uploads finish. */
  clear: () => void;
}

export const useUploadStatusStore = create<UploadStatusState>((set) => ({
  active: false,
  phase: null,
  current: 0,
  total: 0,
  report: (progress) =>
    set({
      active: true,
      phase: progress.phase,
      current: progress.current,
      total: progress.total,
    }),
  clear: () => set({ active: false, phase: null, current: 0, total: 0 }),
}));
