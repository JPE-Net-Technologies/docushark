import type { ConnectionStatus } from '../store/connectionStore';
import { useConnectionStore } from '../store/connectionStore';
import { usePersistenceStore } from '../store/persistenceStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { useCollaborationStore } from './collaborationStore';

/**
 * "Is this shared (relay-backed) doc currently offline?" — the predicate behind
 * the StatusBar's ambient offline chip (JP-237) and the pending-sync marking of
 * pages created offline (JP-335, `pendingSyncPages`).
 *
 * History: this was `offlinePageGuard.ts` (JP-334), which BLOCKED new-page
 * creation while a shared doc was offline. JP-335 lifted the block — offline
 * page creation is now allowed; a created page is marked pending-sync and
 * handed to the relay on reconnect (see `useCollaborationSync`'s handoff).
 *
 * Local-only docs are never "shared offline" (no relay involved).
 */

/** Pure decision: relay-backed AND the live connection isn't fully up. */
export function computeSharedDocOffline(args: {
  currentDocId: string | null;
  collabDocId: string | null;
  collabActive: boolean;
  recordType: string | undefined;
  status: ConnectionStatus;
}): boolean {
  const { currentDocId, collabDocId, collabActive, recordType, status } = args;
  if (!currentDocId) return false;
  // Mirror DocumentEditorPanel's `isRelayDoc`: an active session on this doc, or
  // a registry record that isn't local-only.
  const isRelayDoc =
    (currentDocId === collabDocId && collabActive) ||
    (recordType !== undefined && recordType !== 'local');
  if (!isRelayDoc) return false;
  // `authenticated` is the only fully-live state; anything else can't seed/persist.
  return status !== 'authenticated';
}

/** Store-wired form used by the add-page handlers (imperative, at click time). */
export function sharedDocOffline(): boolean {
  const currentDocId = usePersistenceStore.getState().currentDocumentId;
  const collab = useCollaborationStore.getState();
  return computeSharedDocOffline({
    currentDocId,
    collabDocId: collab.config?.documentId ?? null,
    collabActive: collab.isActive,
    recordType: currentDocId
      ? useDocumentRegistry.getState().getRecord(currentDocId)?.type
      : undefined,
    status: useConnectionStore.getState().status,
  });
}

/** Reactive form for dimming the add-page controls (re-renders on status change). */
export function useSharedDocOffline(): boolean {
  const currentDocId = usePersistenceStore((s) => s.currentDocumentId);
  const collabDocId = useCollaborationStore((s) => s.config?.documentId ?? null);
  const collabActive = useCollaborationStore((s) => s.isActive);
  const status = useConnectionStore((s) => s.status);
  const recordType = useDocumentRegistry((s) =>
    currentDocId ? s.getRecord(currentDocId)?.type : undefined,
  );
  return computeSharedDocOffline({ currentDocId, collabDocId, collabActive, recordType, status });
}
