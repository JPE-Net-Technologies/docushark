/**
 * The autosave switch is never persisted (DSK-207).
 *
 * A guest share load turns autosave off for its read-only snapshot. The switch
 * was in the persisted document index, and guest pages share the editor's
 * origin, so after someone opened a shared link every later editor session in
 * that browser started without autosave, and without the close-tab flush.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePersistenceStore } from './persistenceStore';
import { createDocument } from '../types/Document';
import type { ExternalDocument } from '../types/DocumentRegistry';

const KEY = 'docushark-documents';

beforeEach(() => {
  localStorage.clear();
  usePersistenceStore.setState({ autoSaveEnabled: true });
});

describe('the autosave switch (DSK-207)', () => {
  it('stays out of the persisted index when a guest load turns it off', () => {
    const record = {
      type: 'external',
      source: 'share-link',
      id: 'guest-1',
      name: 'Shared',
      pageCount: 1,
      createdAt: 1,
      modifiedAt: 1,
    } as ExternalDocument;
    usePersistenceStore.getState().loadExternalDocument(createDocument('Shared', 'guest-1', 'page-1'), record);

    // The guest session itself still never autosaves its snapshot…
    expect(usePersistenceStore.getState().autoSaveEnabled).toBe(false);
    // …but nothing about it reaches the storage the editor boots from.
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { state?: Record<string, unknown> };
    expect(stored.state).toBeDefined();
    expect(stored.state).not.toHaveProperty('autoSaveEnabled');
  });

  it('recovers a browser that stored it off, keeping the document index', async () => {
    // Clear the in-memory index first: a setState writes through to storage.
    usePersistenceStore.setState({ documents: {} });
    const documents = { 'doc-1': { id: 'doc-1', name: 'Kept' } };
    localStorage.setItem(KEY, JSON.stringify({ state: { documents, autoSaveEnabled: false }, version: 1 }));

    await usePersistenceStore.persist.rehydrate();

    expect(usePersistenceStore.getState().autoSaveEnabled).toBe(true);
    expect(Object.keys(usePersistenceStore.getState().documents)).toEqual(['doc-1']);
  });
});
