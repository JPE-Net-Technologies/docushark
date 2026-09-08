/**
 * Open a document by id — the one implementation, for every surface.
 *
 * This lived inside `useDocumentBrowserModel` as a hook-bound callback, which
 * meant only the browser could open a document. The command palette's quick-open
 * needs the same behaviour and cannot call a hook, and the obvious shortcut —
 * writing a second version there — is the defect this epic keeps finding: two
 * implementations of one action, drifting quietly (see the Tools menu and the
 * palette describing the same four commands differently).
 *
 * The behaviour is not trivial enough to duplicate safely. A relay-backed
 * document loads over the network and can fail in two distinguishable ways, and
 * "you are offline" versus "that did not work" is the difference between a user
 * who knows to use *Make available offline* and one who thinks the app is
 * broken.
 */

import { useDocumentRegistry } from '../store/documentRegistry';
import { usePersistenceStore } from '../store/persistenceStore';
import {
  useRelayDocumentStore,
  RelayDocumentUnavailableOfflineError,
} from '../store/relayDocumentStore';
import { useNotificationStore } from '../store/notificationStore';

/**
 * Load `docId` into the editor. Resolves once the document is open, or after
 * the failure has been reported to the user — it never rejects, because every
 * caller so far is a UI affordance with nothing useful to do with a throw.
 *
 * A no-op when the document is already open, or unknown to the registry.
 */
export async function openDocumentById(docId: string): Promise<void> {
  const persistence = usePersistenceStore.getState();
  if (docId === persistence.currentDocumentId) return;

  const entry = useDocumentRegistry.getState().entries[docId];
  if (!entry) return;

  const { record } = entry;
  if (record.type !== 'remote' && record.type !== 'cached') {
    persistence.loadDocument(docId);
    return;
  }

  try {
    const doc = await useRelayDocumentStore.getState().loadRelayDocument(docId);
    usePersistenceStore.getState().loadRemoteDocument(doc);
  } catch (error) {
    console.error('Failed to load relay document:', error);
    // Being offline is a different problem with a different fix, and the user
    // can only act on the right one.
    const offline =
      error instanceof RelayDocumentUnavailableOfflineError ||
      (typeof navigator !== 'undefined' && navigator.onLine === false);
    useNotificationStore
      .getState()
      .warning(
        offline
          ? 'This document isn’t available offline. Open it while connected, or use “Make available offline” first, then reopen.'
          : 'Couldn’t open this document. Check your connection and try again.',
      );
  }
}
