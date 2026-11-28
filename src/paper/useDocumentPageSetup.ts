/**
 * The open document's page setup (DSK-48), as Paper Mode and the Document
 * menu show it: its page setting, else its saved export settings, else the
 * locale's paper (`resolvePageSetup`).
 */

import { useMemo } from 'react';
import { loadDocumentPdfSettings, usePersistenceStore } from '../store/persistenceStore';
import { type PageSetup, resolvePageSetup, usePageSetting } from './pageSetup';

export function useDocumentPageSetup(): PageSetup {
  const stored = usePageSetting();
  const documentId = usePersistenceStore((s) => s.currentDocumentId);
  const exportSettings = useMemo(() => (documentId ? loadDocumentPdfSettings(documentId) : null), [documentId]);
  return useMemo(() => resolvePageSetup(stored, exportSettings), [stored, exportSettings]);
}
