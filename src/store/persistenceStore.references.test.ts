/**
 * Persistence wiring for the per-document reference library (JP-89 slice 1).
 *
 * Drives the real public `loadDocument` path (which calls the private
 * `loadDocumentToPageStore`) to prove that `DiagramDocument.references`:
 *   - loads into `referenceStore` when present,
 *   - resets the store to empty when absent (back-compat for pre-JP-89 docs),
 *   - never bleeds a prior document's references into one that has none.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  getMeta: vi.fn(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import { usePersistenceStore } from './persistenceStore';
import { useReferenceStore } from './referenceStore';
import { createDocument, STORAGE_KEYS, type DiagramDocument } from '../types/Document';
import type { CSLItem, ReferenceLibrary } from '../types/Citation';

function item(id: string): CSLItem {
  return { id, type: 'article-journal', title: `Title ${id}` };
}

function library(...ids: string[]): ReferenceLibrary {
  const items: Record<string, CSLItem> = {};
  for (const id of ids) items[id] = item(id);
  return { items, itemOrder: [...ids] };
}

/** Write a DiagramDocument into localStorage where `loadDocument` reads it. */
function seedDoc(id: string, references?: ReferenceLibrary): void {
  const doc: DiagramDocument = createDocument(`Doc ${id}`, id, `${id}-p1`);
  if (references) doc.references = references;
  localStorage.setItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${id}`, JSON.stringify(doc));
}

beforeEach(() => {
  localStorage.clear();
  useReferenceStore.getState().clear();
  vi.restoreAllMocks();
});

describe('persistenceStore reference-library wiring', () => {
  it('loads references from a document that has them', () => {
    seedDoc('doc-a', library('a', 'b'));

    const ok = usePersistenceStore.getState().loadDocument('doc-a');
    expect(ok).toBe(true);

    expect(useReferenceStore.getState().listReferences().map((r) => r.id)).toEqual([
      'a',
      'b',
    ]);
  });

  it('resets to empty for a pre-JP-89 document with no references field', () => {
    // Simulate stale in-memory state from a previously-open document.
    useReferenceStore.getState().addReference(item('stale'));
    seedDoc('doc-old'); // no references field

    usePersistenceStore.getState().loadDocument('doc-old');

    expect(useReferenceStore.getState().listReferences()).toEqual([]);
  });

  it('does not bleed references across documents', () => {
    seedDoc('doc-a', library('a', 'b'));
    seedDoc('doc-b'); // no references

    usePersistenceStore.getState().loadDocument('doc-a');
    expect(useReferenceStore.getState().itemOrder).toEqual(['a', 'b']);

    usePersistenceStore.getState().loadDocument('doc-b');
    expect(useReferenceStore.getState().listReferences()).toEqual([]);
  });
});
