import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTrashItems,
  moveToTrash,
  recoverFromTrash,
  permanentlyDeleteFromTrash,
  emptyTrash,
  cleanupExpiredTrash,
  getTrashItem,
  isInTrash,
  getTrashCount,
  getTrashedBlobReferences,
  getStoredTrashDocument,
  type TrashItem,
} from './TrashStorage';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// Helper to create test documents
function createTestDocument(id: string, name: string): DiagramDocument {
  return {
    id,
    name,
    pages: {},
    pageOrder: ['page-1'],
    activePageId: 'page-1',
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    version: 1,
  };
}

function createTestMetadata(id: string, name: string): DocumentMetadata {
  return {
    id,
    name,
    createdAt: Date.now(),
    modifiedAt: Date.now(),
    pageCount: 1,
  };
}

describe('TrashStorage', () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  describe('getTrashItems', () => {
    it('returns empty array when no trash', () => {
      expect(getTrashItems()).toEqual([]);
    });

    it('filters out expired items', () => {
      const items: TrashItem[] = [
        {
          id: 'doc-1',
          name: 'Valid Doc',
          deletedAt: Date.now(),
          expiresAt: Date.now() + 10000, // Future
          originalMetadata: createTestMetadata('doc-1', 'Valid Doc'),
        },
        {
          id: 'doc-2',
          name: 'Expired Doc',
          deletedAt: Date.now() - 20000,
          expiresAt: Date.now() - 10000, // Past
          originalMetadata: createTestMetadata('doc-2', 'Expired Doc'),
        },
      ];
      localStorageMock.setItem('docushark-trash', JSON.stringify(items));

      const result = getTrashItems();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('Valid Doc');
    });
  });

  describe('moveToTrash', () => {
    it('moves document to trash', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');

      const result = moveToTrash(doc, metadata);

      expect(result).toBe(true);
      expect(getTrashItems()).toHaveLength(1);
      expect(isInTrash('doc-1')).toBe(true);
    });

    it('stores document data for recovery', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');

      moveToTrash(doc, metadata);

      // Document should be stored
      const stored = localStorageMock.getItem('docushark-trash-doc-doc-1');
      expect(stored).not.toBeNull();

      const parsedDoc = JSON.parse(stored!);
      expect(parsedDoc.id).toBe('doc-1');
      expect(parsedDoc.name).toBe('Test Doc');
    });

    it('enforces max items limit', () => {
      // Add 51 items (over limit of 50)
      for (let i = 0; i < 51; i++) {
        const doc = createTestDocument(`doc-${i}`, `Doc ${i}`);
        const metadata = createTestMetadata(`doc-${i}`, `Doc ${i}`);
        moveToTrash(doc, metadata);
      }

      const items = getTrashItems();
      expect(items.length).toBeLessThanOrEqual(50);
    });
  });

  describe('recoverFromTrash', () => {
    it('recovers document from trash', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');
      moveToTrash(doc, metadata);

      const result = recoverFromTrash('doc-1');

      expect(result.success).toBe(true);
      expect(result.document?.id).toBe('doc-1');
      expect(result.document?.name).toBe('Test Doc');
      expect(isInTrash('doc-1')).toBe(false);
    });

    it('returns error for missing document', () => {
      const result = recoverFromTrash('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('removes document from trash storage after recovery', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');
      moveToTrash(doc, metadata);

      recoverFromTrash('doc-1');

      // Document storage should be removed
      expect(localStorageMock.getItem('docushark-trash-doc-doc-1')).toBeNull();
    });
  });

  describe('permanentlyDeleteFromTrash', () => {
    it('permanently deletes from trash', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');
      moveToTrash(doc, metadata);

      const result = permanentlyDeleteFromTrash('doc-1');

      expect(result).toBe(true);
      expect(isInTrash('doc-1')).toBe(false);
      expect(localStorageMock.getItem('docushark-trash-doc-doc-1')).toBeNull();
    });
  });

  describe('emptyTrash', () => {
    it('removes all items from trash', () => {
      for (let i = 0; i < 5; i++) {
        const doc = createTestDocument(`doc-${i}`, `Doc ${i}`);
        const metadata = createTestMetadata(`doc-${i}`, `Doc ${i}`);
        moveToTrash(doc, metadata);
      }

      const deleted = emptyTrash();

      expect(deleted).toBe(5);
      expect(getTrashItems()).toHaveLength(0);
    });
  });

  describe('cleanupExpiredTrash', () => {
    it('removes expired items', () => {
      // Create items with explicit past expiry
      const items: TrashItem[] = [
        {
          id: 'doc-1',
          name: 'Expired Doc',
          deletedAt: Date.now() - 20000,
          expiresAt: Date.now() - 1000, // Already expired
          originalMetadata: createTestMetadata('doc-1', 'Expired Doc'),
        },
      ];
      localStorageMock.setItem('docushark-trash', JSON.stringify(items));
      localStorageMock.setItem('docushark-trash-doc-doc-1', JSON.stringify(createTestDocument('doc-1', 'Expired Doc')));

      const cleaned = cleanupExpiredTrash();

      expect(cleaned).toBe(1);
      expect(localStorageMock.getItem('docushark-trash-doc-doc-1')).toBeNull();
    });

    it('keeps non-expired items', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');

      // Trash with long retention
      moveToTrash(doc, metadata, 3600000);

      const cleaned = cleanupExpiredTrash();

      expect(cleaned).toBe(0);
      expect(getTrashCount()).toBe(1);
    });
  });

  describe('getTrashItem', () => {
    it('returns item by ID', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');
      moveToTrash(doc, metadata);

      const item = getTrashItem('doc-1');

      expect(item).toBeDefined();
      expect(item?.id).toBe('doc-1');
      expect(item?.name).toBe('Test Doc');
    });

    it('returns undefined for missing item', () => {
      expect(getTrashItem('nonexistent')).toBeUndefined();
    });
  });

  describe('isInTrash', () => {
    it('returns true for trashed documents', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const metadata = createTestMetadata('doc-1', 'Test Doc');
      moveToTrash(doc, metadata);

      expect(isInTrash('doc-1')).toBe(true);
    });

    it('returns false for non-trashed documents', () => {
      expect(isInTrash('doc-1')).toBe(false);
    });
  });

  describe('kind / origin / blobReferences (JP-291)', () => {
    it('defaults to local kind and snapshots blobReferences from the doc', () => {
      const doc = { ...createTestDocument('doc-1', 'Test Doc'), blobReferences: ['blob-a', 'blob-b'] };
      moveToTrash(doc, createTestMetadata('doc-1', 'Test Doc'));

      const item = getTrashItem('doc-1');
      expect(item?.kind).toBe('local');
      expect(item?.blobReferences).toEqual(['blob-a', 'blob-b']);
      expect(item?.origin).toBeUndefined();
    });

    it('records stranded kind + origin + explicit blobReferences', () => {
      const doc = createTestDocument('doc-2', 'Stranded Doc');
      moveToTrash(doc, createTestMetadata('doc-2', 'Stranded Doc'), undefined, {
        kind: 'stranded',
        origin: { relayId: 'relay-1', ownerId: 'user-1', lastSyncedAt: 123 },
        blobReferences: ['blob-c'],
      });

      const item = getTrashItem('doc-2');
      expect(item?.kind).toBe('stranded');
      expect(item?.origin).toEqual({ relayId: 'relay-1', ownerId: 'user-1', lastSyncedAt: 123 });
      expect(item?.blobReferences).toEqual(['blob-c']);
    });

    it('getStoredTrashDocument reads bytes without recovering', () => {
      const doc = createTestDocument('doc-3', 'Test Doc');
      moveToTrash(doc, createTestMetadata('doc-3', 'Test Doc'));

      expect(getStoredTrashDocument('doc-3')?.id).toBe('doc-3');
      expect(isInTrash('doc-3')).toBe(true); // still in trash
      expect(getStoredTrashDocument('missing')).toBeNull();
    });
  });

  describe('getTrashedBlobReferences (GC mark-set source)', () => {
    it('unions blob refs across all non-expired trashed docs', () => {
      moveToTrash(createTestDocument('doc-1', 'A'), createTestMetadata('doc-1', 'A'), undefined, {
        blobReferences: ['blob-a', 'blob-shared'],
      });
      moveToTrash(createTestDocument('doc-2', 'B'), createTestMetadata('doc-2', 'B'), undefined, {
        blobReferences: ['blob-b', 'blob-shared'],
      });

      const refs = getTrashedBlobReferences();
      expect(refs).toEqual(new Set(['blob-a', 'blob-b', 'blob-shared']));
    });

    it('drops a doc\'s refs once it is purged (so the GC can reclaim)', () => {
      moveToTrash(createTestDocument('doc-1', 'A'), createTestMetadata('doc-1', 'A'), undefined, {
        blobReferences: ['blob-a'],
      });
      expect(getTrashedBlobReferences().has('blob-a')).toBe(true);

      permanentlyDeleteFromTrash('doc-1');
      expect(getTrashedBlobReferences().has('blob-a')).toBe(false);
    });

    it('falls back to the stored document for legacy items without blobReferences', () => {
      // Simulate a pre-JP-291 trash entry: list item lacks blobReferences, but
      // the stored document carries them.
      const items: TrashItem[] = [
        {
          id: 'legacy-1',
          name: 'Legacy',
          deletedAt: Date.now(),
          expiresAt: Date.now() + 100000,
          originalMetadata: createTestMetadata('legacy-1', 'Legacy'),
        },
      ];
      localStorageMock.setItem('docushark-trash', JSON.stringify(items));
      localStorageMock.setItem(
        'docushark-trash-doc-legacy-1',
        JSON.stringify({ ...createTestDocument('legacy-1', 'Legacy'), blobReferences: ['legacy-blob'] })
      );

      expect(getTrashedBlobReferences().has('legacy-blob')).toBe(true);
    });
  });

  describe('getTrashCount', () => {
    it('returns correct count', () => {
      expect(getTrashCount()).toBe(0);

      const doc1 = createTestDocument('doc-1', 'Doc 1');
      const doc2 = createTestDocument('doc-2', 'Doc 2');
      moveToTrash(doc1, createTestMetadata('doc-1', 'Doc 1'));
      moveToTrash(doc2, createTestMetadata('doc-2', 'Doc 2'));

      expect(getTrashCount()).toBe(2);
    });
  });
});
