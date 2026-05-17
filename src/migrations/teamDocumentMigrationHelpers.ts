/**
 * Persistence-store glue for the team-document migration. Kept in a
 * separate file so the migration core (`teamDocumentMigration.ts`)
 * stays import-free of Zustand and easy to unit-test.
 */

import type { StoreApi, UseBoundStore } from 'zustand';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';
import { useDocumentRegistry } from '../store/documentRegistry';

export { saveDocumentToStorage } from '../store/persistenceStore';

interface MinimalPersistenceState {
  documents: Record<string, DocumentMetadata>;
}

/**
 * Insert (or overwrite) the doc in both `usePersistenceStore.documents`
 * (legacy index) and `useDocumentRegistry.entries` (the unified registry
 * the Documents UI reads from) so the doc surfaces immediately. Mirrors
 * what `persistenceStore.saveDocument` does on a normal save path.
 */
export function registerLocalDocument(
  store: UseBoundStore<StoreApi<MinimalPersistenceState>>,
  doc: DiagramDocument,
): void {
  const metadata = getDocumentMetadata(doc);
  store.setState((state) => ({
    documents: {
      ...state.documents,
      [doc.id]: metadata,
    },
  }));
  useDocumentRegistry.getState().registerLocal(metadata);
}
