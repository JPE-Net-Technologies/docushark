/**
 * Tests for BackupExportService and BackupImportService.
 *
 * Tests the full backup export → validate → import round-trip,
 * selective export, and merge/replace restore modes.
 */

import { readArchiveZip, decodeJSON, validateManifest } from './ArchiveUtils';
import type { BackupOptions, ArchiveProgress } from './ArchiveTypes';
import { DEFAULT_BACKUP_OPTIONS } from './ArchiveTypes';
import { createBackup, getLastBackupTimestamp } from './BackupExportService';
import { validateBackup, restoreBackup } from './BackupImportService';
import type { DiagramDocument } from '../types/Document';
import { STORAGE_KEYS, getDocumentMetadata } from '../types/Document';
import { usePersistenceStore, saveDocumentToStorage } from '../store/persistenceStore';
import { useStyleProfileStore } from '../store/styleProfileStore';
import { useSettingsStore } from '../store/settingsStore';

// ---------------------------------------------------------------------------
// Mock blobStorage (IndexedDB not available in jsdom)
// ---------------------------------------------------------------------------

const mockBlobStore = new Map<string, { data: Uint8Array; mimeType: string; usageCount: number }>();
const mockShapeItems = new Map<string, unknown>();

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
      return b ? b.data : null;
    }),
    saveBlob: vi.fn(async (blob: { data: Uint8Array; mimeType: string }, id: string) => {
      mockBlobStore.set(id, { data: blob.data, mimeType: blob.mimeType, usageCount: 1 });
      return id;
    }),
    getBlobMetadata: vi.fn(async (id: string) => {
      const b = mockBlobStore.get(id);
      return b ? { id, mimeType: b.mimeType, size: b.data.byteLength, usageCount: b.usageCount, createdAt: Date.now() } : null;
    }),
    incrementUsageCount: vi.fn(async () => {}),
    deleteBlob: vi.fn(async (id: string) => {
      mockBlobStore.delete(id);
    }),
    listAllShapeItems: vi.fn(async () => Array.from(mockShapeItems.values())),
    saveShapeItem: vi.fn(async (item: unknown) => {
      const typed = item as { id: string };
      mockShapeItems.set(typed.id, item);
    }),
  },
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

function createTestDocument(id: string, name: string): DiagramDocument {
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
    blobReferences: [],
  };
}

function seedTestDocument(id: string, name: string): void {
  const doc = createTestDocument(id, name);
  saveDocumentToStorage(doc);
  const metadata = getDocumentMetadata(doc);
  usePersistenceStore.setState((state) => ({
    documents: { ...state.documents, [id]: metadata },
  }));
}

function clearAllTestData(): void {
  const docs = usePersistenceStore.getState().documents;
  for (const docId of Object.keys(docs)) {
    localStorage.removeItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}${docId}`);
  }
  usePersistenceStore.setState({ documents: {} });
  useStyleProfileStore.setState({ profiles: [] });
  localStorage.removeItem('diagrammer-last-backup');
  mockBlobStore.clear();
  mockShapeItems.clear();
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
// BackupExportService tests
// ---------------------------------------------------------------------------

describe('BackupExportService', () => {
  describe('createBackup', () => {
    it('creates a valid ZIP with manifest', async () => {
      seedTestDocument('doc-1', 'Test Doc');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      expect(blob.size).toBeGreaterThan(0);

      const data = await blobToUint8Array(blob);
      const entries = readArchiveZip(data);

      const manifestEntry = entries.find((e) => e.path === 'manifest.json');
      expect(manifestEntry).toBeDefined();

      const manifest = validateManifest(decodeJSON(manifestEntry!.data));
      expect(manifest.version).toBe(1);
      expect(manifest.type).toBe('diagrammer-backup');
      expect(manifest.contents.documentCount).toBe(1);
      expect(manifest.contents.documentIds).toContain('doc-1');
    });

    it('includes documents as JSON files', async () => {
      seedTestDocument('doc-a', 'Alpha');
      seedTestDocument('doc-b', 'Beta');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const docEntries = entries.filter((e) => e.path.startsWith('documents/'));
      expect(docEntries).toHaveLength(2);

      const docA = docEntries.find((e) => e.path === 'documents/doc-a.json');
      expect(docA).toBeDefined();
      const parsed = decodeJSON<DiagramDocument>(docA!.data);
      expect(parsed.name).toBe('Alpha');
    });

    it('includes settings JSON', async () => {
      useSettingsStore.setState({ gridOpacity: 42 });

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const settingsEntry = entries.find((e) => e.path === 'settings.json');
      expect(settingsEntry).toBeDefined();
      const settings = decodeJSON<Record<string, unknown>>(settingsEntry!.data);
      expect(settings['gridOpacity']).toBe(42);
    });

    it('includes style profiles', async () => {
      useStyleProfileStore.setState({
        profiles: [
          {
            id: 'prof-1',
            name: 'My Profile',
            properties: { fill: '#ff0000', stroke: '#000', strokeWidth: 2, opacity: 1 },
            createdAt: Date.now(),
            favorite: false,
          },
        ],
      });

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const profilesEntry = entries.find((e) => e.path === 'style-profiles.json');
      expect(profilesEntry).toBeDefined();

      const manifest = validateManifest(
        decodeJSON(entries.find((e) => e.path === 'manifest.json')!.data)
      );
      expect(manifest.contents.styleProfileCount).toBe(1);
    });

    it('records last backup timestamp', async () => {
      expect(getLastBackupTimestamp()).toBeNull();

      await createBackup(DEFAULT_BACKUP_OPTIONS);

      const ts = getLastBackupTimestamp();
      expect(ts).not.toBeNull();
      expect(ts!).toBeGreaterThan(Date.now() - 5000);
    });

    it('reports progress', async () => {
      seedTestDocument('doc-progress', 'Progress Test');

      const phases: string[] = [];
      await createBackup(DEFAULT_BACKUP_OPTIONS, (p: ArchiveProgress) => {
        phases.push(p.phase);
      });

      expect(phases).toContain('collecting');
      expect(phases).toContain('compressing');
      expect(phases).toContain('done');
    });
  });

  describe('selective export', () => {
    it('excludes documents when not selected', async () => {
      seedTestDocument('doc-skip', 'Skipped');

      const opts: BackupOptions = {
        ...DEFAULT_BACKUP_OPTIONS,
        includeDocuments: false,
      };
      const blob = await createBackup(opts);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const docEntries = entries.filter((e) => e.path.startsWith('documents/'));
      expect(docEntries).toHaveLength(0);

      const manifest = validateManifest(
        decodeJSON(entries.find((e) => e.path === 'manifest.json')!.data)
      );
      expect(manifest.contents.documentCount).toBe(0);
    });

    it('excludes settings when not selected', async () => {
      const opts: BackupOptions = {
        ...DEFAULT_BACKUP_OPTIONS,
        includeSettings: false,
      };
      const blob = await createBackup(opts);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const settingsEntry = entries.find((e) => e.path === 'settings.json');
      expect(settingsEntry).toBeUndefined();
    });

    it('creates a minimal backup with only settings', async () => {
      seedTestDocument('doc-not-included', 'Not Included');

      const opts: BackupOptions = {
        includeDocuments: false,
        includeBlobs: false,
        includeSettings: true,
        includeStyleProfiles: false,
        includeColorPalette: false,
        includeShapeLibraries: false,
        includeIconLibrary: false,
        includeUiPreferences: false,
        includeIconPresets: false,
      };

      const blob = await createBackup(opts);
      const entries = readArchiveZip(await blobToUint8Array(blob));

      const paths = entries.map((e) => e.path);
      expect(paths).toContain('manifest.json');
      expect(paths).toContain('settings.json');
      expect(paths.filter((p) => p.startsWith('documents/'))).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// BackupImportService tests
// ---------------------------------------------------------------------------

describe('BackupImportService', () => {
  describe('validateBackup', () => {
    it('validates a valid backup file', async () => {
      seedTestDocument('doc-val', 'Validation Test');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      clearAllTestData();

      const result = await validateBackup(file);
      expect(result.valid).toBe(true);
      expect(result.manifest).not.toBeNull();
      expect(result.manifest!.contents.documentCount).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it('detects document conflicts', async () => {
      seedTestDocument('doc-conflict', 'Original');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      const result = await validateBackup(file);
      expect(result.valid).toBe(true);
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0]!.type).toBe('document');
      expect(result.conflicts[0]!.id).toBe('doc:doc-conflict');
    });

    it('rejects invalid ZIP data', async () => {
      const file = new File(['not a zip file'], 'bad.diagrammer-backup');
      const result = await validateBackup(file);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('restoreBackup', () => {
    it('restores documents in replace mode', async () => {
      seedTestDocument('doc-r1', 'Doc R1');
      seedTestDocument('doc-r2', 'Doc R2');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      clearAllTestData();
      expect(Object.keys(usePersistenceStore.getState().documents)).toHaveLength(0);

      const result = await restoreBackup(file, {
        mode: 'replace',
        conflictResolutions: {},
      });

      expect(result.success).toBe(true);
      expect(result.restored.documents).toBe(2);
      expect(result.restored.settings).toBe(true);

      const docs = usePersistenceStore.getState().documents;
      expect(Object.keys(docs)).toHaveLength(2);
      expect(docs['doc-r1']).toBeDefined();
      expect(docs['doc-r2']).toBeDefined();
    });

    it('merges documents without conflicts', async () => {
      seedTestDocument('doc-existing', 'Existing Doc');

      clearAllTestData();
      seedTestDocument('doc-new', 'New Doc');
      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      clearAllTestData();
      seedTestDocument('doc-existing', 'Existing Doc');

      const result = await restoreBackup(file, {
        mode: 'merge',
        conflictResolutions: {},
      });

      expect(result.success).toBe(true);
      expect(result.restored.documents).toBe(1);

      const docs = usePersistenceStore.getState().documents;
      expect(docs['doc-existing']).toBeDefined();
      expect(docs['doc-new']).toBeDefined();
    });

    it('respects conflict resolution: keep-existing', async () => {
      seedTestDocument('doc-dup', 'Original Version');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      const modDoc = createTestDocument('doc-dup', 'Modified Version');
      saveDocumentToStorage(modDoc);

      const result = await restoreBackup(file, {
        mode: 'merge',
        conflictResolutions: { 'doc:doc-dup': 'keep-existing' },
      });

      expect(result.success).toBe(true);
      const stored = JSON.parse(localStorage.getItem(`${STORAGE_KEYS.DOCUMENT_PREFIX}doc-dup`) ?? '{}');
      expect(stored.name).toBe('Modified Version');
    });

    it('reports progress during restore', async () => {
      seedTestDocument('doc-p', 'Progress');

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });
      clearAllTestData();

      const phases: string[] = [];
      await restoreBackup(
        file,
        { mode: 'replace', conflictResolutions: {} },
        (p) => { phases.push(p.phase); }
      );

      expect(phases).toContain('reading');
      expect(phases).toContain('validating');
      expect(phases).toContain('done');
    });

    it('restores settings', async () => {
      useSettingsStore.setState({ gridOpacity: 77 });

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'test.diagrammer-backup', { type: 'application/zip' });

      useSettingsStore.setState({ gridOpacity: 50 });

      clearAllTestData();
      await restoreBackup(file, {
        mode: 'replace',
        conflictResolutions: {},
      });

      expect(useSettingsStore.getState().gridOpacity).toBe(77);
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip integration test
  // ---------------------------------------------------------------------------

  describe('round-trip integration', () => {
    it('export → validate → import preserves data', async () => {
      seedTestDocument('rt-1', 'Round Trip Doc 1');
      seedTestDocument('rt-2', 'Round Trip Doc 2');
      useSettingsStore.setState({ animationDuration: 999 });
      useStyleProfileStore.setState({
        profiles: [{
          id: 'rt-profile',
          name: 'Round Trip Profile',
          properties: { fill: '#abc', stroke: '#def', strokeWidth: 3, opacity: 0.8 },
          createdAt: Date.now(),
          favorite: true,
        }],
      });

      const blob = await createBackup(DEFAULT_BACKUP_OPTIONS);
      const file = new File([blob], 'roundtrip.diagrammer-backup', { type: 'application/zip' });

      clearAllTestData();
      const validation = await validateBackup(file);
      expect(validation.valid).toBe(true);
      expect(validation.manifest!.contents.documentCount).toBe(2);
      expect(validation.manifest!.contents.styleProfileCount).toBe(1);

      const result = await restoreBackup(file, {
        mode: 'replace',
        conflictResolutions: {},
      });

      expect(result.success).toBe(true);
      expect(result.restored.documents).toBe(2);
      expect(result.restored.settings).toBe(true);
      expect(result.restored.styleProfiles).toBe(1);

      const docs = usePersistenceStore.getState().documents;
      expect(docs['rt-1']?.name).toBe('Round Trip Doc 1');
      expect(docs['rt-2']?.name).toBe('Round Trip Doc 2');

      expect(useSettingsStore.getState().animationDuration).toBe(999);

      const profiles = useStyleProfileStore.getState().profiles;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]!.name).toBe('Round Trip Profile');
      expect(profiles[0]!.favorite).toBe(true);
    });
  });
});
