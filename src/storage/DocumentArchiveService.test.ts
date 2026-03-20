/**
 * Tests for DocumentArchiveService.
 *
 * Tests the per-document archive export → validate → import round-trip,
 * blob handling, and error cases.
 */

/// <reference types="vitest/globals" />

import { readArchiveZip, createArchiveZip, encodeJSON, decodeJSON, validateManifest } from './ArchiveUtils';
import {
  exportDocumentArchive,
  validateDocumentArchive,
  importDocumentArchive,
} from './DocumentArchiveService';
import type { DiagramDocument } from '../types/Document';
import { STORAGE_KEYS, getDocumentMetadata } from '../types/Document';
import { usePersistenceStore, saveDocumentToStorage } from '../store/persistenceStore';

// ---------------------------------------------------------------------------
// Mock blobStorage (IndexedDB not available in jsdom)
// ---------------------------------------------------------------------------

const mockBlobStore = new Map<string, { data: Uint8Array; mimeType: string; usageCount: number }>();

vi.mock('./BlobStorage', () => ({
  blobStorage: {
    getStorageStats: vi.fn(async () => ({
      blobCount: mockBlobStore.size,
      totalSize: Array.from(mockBlobStore.values()).reduce((sum, b) => sum + b.data.byteLength, 0),
    })),
    listAllBlobs: vi.fn(async () =>
      Array.from(mockBlobStore.entries()).map(([id, b]) => ({
        id,
        mimeType: b.mimeType,
        size: b.data.byteLength,
        usageCount: b.usageCount,
        createdAt: Date.now(),
      }))
    ),
    loadBlob: vi.fn(async (id: string) => {
      const b = mockBlobStore.get(id);
      return b ? new Blob([b.data as BlobPart]) : null;
    }),
    saveBlob: vi.fn(async (blob: Blob, id: string) => {
      const data = await new Promise<Uint8Array>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
      mockBlobStore.set(id, { data, mimeType: 'application/octet-stream', usageCount: 1 });
      return id;
    }),
    getBlobMetadata: vi.fn(async (id: string) => {
      const b = mockBlobStore.get(id);
      return b ? { id, mimeType: b.mimeType, size: b.data.byteLength, usageCount: b.usageCount, createdAt: Date.now() } : null;
    }),
    incrementUsageCount: vi.fn(async (id: string) => {
      const b = mockBlobStore.get(id);
      if (b) b.usageCount++;
    }),
    deleteBlob: vi.fn(async (id: string) => {
      mockBlobStore.delete(id);
    }),
    listAllShapeItems: vi.fn(async () => []),
    saveShapeItem: vi.fn(async () => {}),
  },
}));

// Mock documentRegistry
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: Object.assign(
    () => ({}),
    {
      getState: () => ({
        registerLocal: vi.fn(),
        setActiveDocument: vi.fn(),
        setDocumentContent: vi.fn(),
      }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    }
  ),
}));

// Mock notificationStore
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: Object.assign(
    () => ({}),
    {
      getState: () => ({
        success: vi.fn(),
        error: vi.fn(),
      }),
    }
  ),
}));

// ---------------------------------------------------------------------------
// Helper to convert Blob to Uint8Array (jsdom Blob lacks arrayBuffer())
// ---------------------------------------------------------------------------

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDocument(id: string, name: string, blobRefs: string[] = []): DiagramDocument {
  const now = Date.now();
  return {
    id,
    name,
    version: 1,
    createdAt: now,
    modifiedAt: now,
    pages: {
      'page-1': {
        id: 'page-1',
        name: 'Page 1',
        shapes: {},
        shapeOrder: [],
        createdAt: now,
        modifiedAt: now,
      },
    },
    pageOrder: ['page-1'],
    activePageId: 'page-1',
    blobReferences: blobRefs,
  };
}

function seedTestDocument(id: string, name: string, blobRefs: string[] = []): void {
  const doc = createTestDocument(id, name, blobRefs);
  saveDocumentToStorage(doc);
  const metadata = getDocumentMetadata(doc);
  usePersistenceStore.setState((state) => ({
    documents: { ...state.documents, [id]: metadata },
  }));
}

function seedBlob(id: string, content: Uint8Array): void {
  mockBlobStore.set(id, { data: content, mimeType: 'image/png', usageCount: 1 });
}

function clearAllTestData(): void {
  const docs = usePersistenceStore.getState().documents;
  for (const docId of Object.keys(docs)) {
    localStorage.removeItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${docId}`);
  }
  usePersistenceStore.setState({ documents: {} });
  mockBlobStore.clear();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAllTestData();
});

afterEach(() => {
  clearAllTestData();
});

// ---------------------------------------------------------------------------
// Export tests
// ---------------------------------------------------------------------------

describe('DocumentArchiveService', () => {
  describe('exportDocumentArchive', () => {
    it('creates a valid ZIP with manifest type diagrammer-document-archive', async () => {
      seedTestDocument('doc-1', 'Test Doc');

      const { blob, blobCount } = await exportDocumentArchive('doc-1');
      expect(blob.size).toBeGreaterThan(0);
      expect(blobCount).toBe(0);

      const data = await blobToUint8Array(blob);
      const entries = readArchiveZip(data);

      const manifestEntry = entries.find((e) => e.path === 'manifest.json');
      expect(manifestEntry).toBeDefined();

      const manifest = validateManifest(decodeJSON(manifestEntry!.data));
      expect(manifest.version).toBe(1);
      expect(manifest.type).toBe('diagrammer-document-archive');
      expect(manifest.contents.documentCount).toBe(1);
      expect(manifest.contents.documentIds).toContain('doc-1');
    });

    it('includes the document as a JSON file', async () => {
      seedTestDocument('doc-a', 'Alpha');

      const { blob } = await exportDocumentArchive('doc-a');
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const docEntry = entries.find((e) => e.path === 'documents/doc-a.json');
      expect(docEntry).toBeDefined();

      const parsed = decodeJSON<DiagramDocument>(docEntry!.data);
      expect(parsed.name).toBe('Alpha');
      expect(parsed.id).toBe('doc-a');
    });

    it('includes referenced blobs', async () => {
      const blobData = new Uint8Array([1, 2, 3, 4, 5]);
      seedBlob('blob-abc', blobData);
      seedTestDocument('doc-b', 'With Blob', ['blob-abc']);

      const { blob, blobCount, blobTotalSize } = await exportDocumentArchive('doc-b');
      expect(blobCount).toBe(1);
      expect(blobTotalSize).toBe(5);

      const entries = readArchiveZip(await blobToUint8Array(blob));
      const blobEntry = entries.find((e) => e.path === 'blobs/blob-abc.bin');
      expect(blobEntry).toBeDefined();
      expect(Array.from(blobEntry!.data)).toEqual([1, 2, 3, 4, 5]);
    });

    it('exports document with multiple blobs', async () => {
      seedBlob('blob-1', new Uint8Array([10, 20]));
      seedBlob('blob-2', new Uint8Array([30, 40, 50]));
      seedTestDocument('doc-multi', 'Multi Blob', ['blob-1', 'blob-2']);

      const { blobCount, blobTotalSize } = await exportDocumentArchive('doc-multi');
      expect(blobCount).toBe(2);
      expect(blobTotalSize).toBe(5);
    });

    it('throws if document is not found', async () => {
      await expect(exportDocumentArchive('nonexistent')).rejects.toThrow('Document not found');
    });

    it('reports progress during export', async () => {
      seedTestDocument('doc-progress', 'Progress Test');

      const phases: string[] = [];
      await exportDocumentArchive('doc-progress', (p) => {
        phases.push(p.phase);
      });

      expect(phases).toContain('collecting');
      expect(phases).toContain('compressing');
      expect(phases).toContain('done');
    });

    it('sets document-archive-specific manifest contents to zero/false', async () => {
      seedTestDocument('doc-c', 'Contents Test');

      const { blob } = await exportDocumentArchive('doc-c');
      const entries = readArchiveZip(await blobToUint8Array(blob));
      const manifest = validateManifest(decodeJSON(entries.find((e) => e.path === 'manifest.json')!.data));

      expect(manifest.contents.shapeLibraryCount).toBe(0);
      expect(manifest.contents.shapeLibraryItemCount).toBe(0);
      expect(manifest.contents.styleProfileCount).toBe(0);
      expect(manifest.contents.hasSettings).toBe(false);
      expect(manifest.contents.hasColorPalette).toBe(false);
      expect(manifest.contents.hasIconLibrary).toBe(false);
      expect(manifest.contents.hasUiPreferences).toBe(false);
      expect(manifest.contents.hasIconPresets).toBe(false);
    });

    it('checksums are valid for all entries', async () => {
      seedBlob('blob-ck', new Uint8Array([99]));
      seedTestDocument('doc-ck', 'Checksum Test', ['blob-ck']);

      const { blob } = await exportDocumentArchive('doc-ck');
      const entries = readArchiveZip(await blobToUint8Array(blob));
      const manifest = validateManifest(decodeJSON(entries.find((e) => e.path === 'manifest.json')!.data));

      // All checksummed files should be present and valid
      for (const [path] of Object.entries(manifest.checksums)) {
        const entry = entries.find((e) => e.path === path);
        expect(entry).toBeDefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Validation tests
  // ---------------------------------------------------------------------------

  describe('validateDocumentArchive', () => {
    it('validates a valid document archive', async () => {
      seedTestDocument('doc-val', 'Validation Test');
      const { blob } = await exportDocumentArchive('doc-val');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      const result = await validateDocumentArchive(file);
      expect(result.valid).toBe(true);
      expect(result.manifest).not.toBeNull();
      expect(result.manifest!.type).toBe('diagrammer-document-archive');
      expect(result.manifest!.contents.documentCount).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it('rejects a non-ZIP file', async () => {
      const file = new File([new Uint8Array([0, 1, 2])], 'bad.diagrammer');

      const result = await validateDocumentArchive(file);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('rejects a ZIP without manifest', async () => {
      // Create a valid ZIP but without manifest.json
      const zipData = createArchiveZip([{ path: 'dummy.txt', data: encodeJSON('hello') }]);
      const file = new File([zipData as BlobPart], 'no-manifest.diagrammer', { type: 'application/zip' });

      const result = await validateDocumentArchive(file);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Archive is missing manifest.json');
    });

    it('detects conflicts with existing documents', async () => {
      seedTestDocument('doc-conflict', 'Conflict Test');
      const { blob } = await exportDocumentArchive('doc-conflict');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      // Don't clear — the doc still exists, so there should be a conflict
      const result = await validateDocumentArchive(file);
      expect(result.valid).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.type).toBe('document');
      expect(result.conflicts[0]!.id).toBe('doc:doc-conflict');
    });

    it('rejects archive with wrong type', async () => {
      // Manually create an archive with backup type instead of document-archive
      const manifest = {
        version: 1,
        type: 'diagrammer-backup',
        createdAt: Date.now(),
        appVersion: '1.0.0',
        contents: {
          documentCount: 0,
          documentIds: [],
          blobCount: 0,
          blobTotalSize: 0,
          shapeLibraryCount: 0,
          shapeLibraryItemCount: 0,
          styleProfileCount: 0,
          hasSettings: false,
          hasColorPalette: false,
          hasIconLibrary: false,
          hasUiPreferences: false,
          hasIconPresets: false,
        },
        checksums: {},
      };
      const zipData = createArchiveZip([{ path: 'manifest.json', data: encodeJSON(manifest) }]);
      const file = new File([zipData as BlobPart], 'backup.diagrammer', { type: 'application/zip' });

      const result = await validateDocumentArchive(file);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Unexpected archive type'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Import tests
  // ---------------------------------------------------------------------------

  describe('importDocumentArchive', () => {
    it('imports a document archive and creates a new document', async () => {
      seedTestDocument('doc-imp', 'Import Me');
      const { blob } = await exportDocumentArchive('doc-imp');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(true);
      expect(result.documentId).not.toBeNull();
      expect(result.documentName).toBe('Import Me');
      expect(result.warnings).toHaveLength(0);

      // Verify document was saved with a NEW ID (not the original)
      expect(result.documentId).not.toBe('doc-imp');

      // Verify document is in persistence store
      const docs = usePersistenceStore.getState().documents;
      expect(docs[result.documentId!]).toBeDefined();
      expect(docs[result.documentId!]!.name).toBe('Import Me');
    });

    it('restores blobs from the archive', async () => {
      const blobData = new Uint8Array([10, 20, 30]);
      seedBlob('blob-restore', blobData);
      seedTestDocument('doc-blobs', 'Blob Doc', ['blob-restore']);

      const { blob } = await exportDocumentArchive('doc-blobs');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(true);
      expect(result.blobsRestored).toBe(1);

      // Verify blob was saved
      expect(mockBlobStore.has('blob-restore')).toBe(true);
    });

    it('deduplicates blobs that already exist locally', async () => {
      const blobData = new Uint8Array([42, 43, 44]);
      seedBlob('blob-dedup', blobData);
      seedTestDocument('doc-dedup', 'Dedup Doc', ['blob-dedup']);

      const { blob } = await exportDocumentArchive('doc-dedup');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      // Don't clear blobs — blob-dedup still exists locally
      const docs = usePersistenceStore.getState().documents;
      for (const docId of Object.keys(docs)) {
        localStorage.removeItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${docId}`);
      }
      usePersistenceStore.setState({ documents: {} });

      const { blobStorage } = await import('./BlobStorage');
      const saveSpyCount = (blobStorage.saveBlob as ReturnType<typeof vi.fn>).mock.calls.length;

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(true);
      expect(result.blobsRestored).toBe(1);

      // saveBlob should NOT have been called again because blob already exists
      expect((blobStorage.saveBlob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(saveSpyCount);
    });

    it('works with documents that have no blobs', async () => {
      seedTestDocument('doc-noblobs', 'No Blobs');
      const { blob } = await exportDocumentArchive('doc-noblobs');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(true);
      expect(result.blobsRestored).toBe(0);
      expect(result.documentName).toBe('No Blobs');
    });

    it('rejects a non-ZIP file', async () => {
      const file = new File([new Uint8Array([0, 1, 2])], 'bad.diagrammer');

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(false);
      expect(result.documentId).toBeNull();
    });

    it('rejects an archive with wrong type', async () => {
      const manifest = {
        version: 1,
        type: 'diagrammer-backup',
        createdAt: Date.now(),
        appVersion: '1.0.0',
        contents: {
          documentCount: 0, documentIds: [], blobCount: 0, blobTotalSize: 0,
          shapeLibraryCount: 0, shapeLibraryItemCount: 0, styleProfileCount: 0,
          hasSettings: false, hasColorPalette: false, hasIconLibrary: false,
          hasUiPreferences: false, hasIconPresets: false,
        },
        checksums: {},
      };
      const zipData = createArchiveZip([{ path: 'manifest.json', data: encodeJSON(manifest) }]);
      const file = new File([zipData as BlobPart], 'wrong-type.diagrammer', { type: 'application/zip' });

      const result = await importDocumentArchive(file);
      expect(result.success).toBe(false);
      expect(result.warnings.some((w) => w.includes('Unexpected archive type'))).toBe(true);
    });

    it('increments blob usage counts on import', async () => {
      seedBlob('blob-usage', new Uint8Array([1]));
      seedTestDocument('doc-usage', 'Usage Doc', ['blob-usage']);

      const { blob } = await exportDocumentArchive('doc-usage');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      // Re-seed the blob so it exists (simulating dedup scenario)
      seedBlob('blob-usage', new Uint8Array([1]));
      const initialUsage = mockBlobStore.get('blob-usage')!.usageCount;

      await importDocumentArchive(file);

      expect(mockBlobStore.get('blob-usage')!.usageCount).toBe(initialUsage + 1);
    });

    it('reports progress during import', async () => {
      seedTestDocument('doc-prog', 'Progress Doc');
      const { blob } = await exportDocumentArchive('doc-prog');
      const file = new File([blob], 'test.diagrammer', { type: 'application/zip' });

      clearAllTestData();

      const phases: string[] = [];
      await importDocumentArchive(file, (p) => {
        phases.push(p.phase);
      });

      expect(phases).toContain('reading');
      expect(phases).toContain('validating');
      expect(phases).toContain('done');
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip tests
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('export then import preserves document data', async () => {
      seedBlob('blob-rt', new Uint8Array([100, 200]));
      seedTestDocument('doc-rt', 'Round Trip', ['blob-rt']);

      // Export
      const { blob } = await exportDocumentArchive('doc-rt');
      const file = new File([blob], 'round-trip.diagrammer', { type: 'application/zip' });

      // Clear everything
      clearAllTestData();

      // Import
      const result = await importDocumentArchive(file);
      expect(result.success).toBe(true);
      expect(result.documentName).toBe('Round Trip');
      expect(result.blobsRestored).toBe(1);

      // Verify blob data survived the round trip
      const restoredBlob = mockBlobStore.get('blob-rt');
      expect(restoredBlob).toBeDefined();
      expect(Array.from(restoredBlob!.data)).toEqual([100, 200]);
    });
  });
});
