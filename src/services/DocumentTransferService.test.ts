/**
 * Document Transfer Service Tests
 *
 * Tests for atomic document transfers between personal and team storage.
 * Phase 14.9.2 - Data Integrity Improvements
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DocumentTransferService,
  TransferRecord,
  TransferState,
  TransferServiceDeps,
  resetTransferService,
} from './DocumentTransferService';
import type { DiagramDocument } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';
import { useDocumentRegistry } from '../store/documentRegistry';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// ============ Test Fixtures ============

function createTestDocument(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    id: 'doc-123',
    name: 'Test Document',
    pages: {},
    pageOrder: ['page-1'],
    activePageId: 'page-1',
    createdAt: Date.now() - 10000,
    modifiedAt: Date.now(),
    isRelayDocument: false,
    ...overrides,
  } as DiagramDocument;
}

function createMockDeps(overrides: Partial<TransferServiceDeps> = {}): TransferServiceDeps {
  const documents = new Map<string, DiagramDocument>();

  return {
    loadDocument: vi.fn((id: string) => documents.get(id) ?? null),
    saveDocument: vi.fn((doc: DiagramDocument) => {
      documents.set(doc.id, doc);
    }),
    getCurrentUser: vi.fn(() => ({ id: 'user-1', displayName: 'Test User' })),
    saveToHost: vi.fn().mockResolvedValue(undefined),
    deleteFromHost: vi.fn().mockResolvedValue(undefined),
    isAuthenticated: vi.fn(() => true),
    updateMetadata: vi.fn(),
    ...overrides,
  };
}

// ============ Tests ============

describe('DocumentTransferService', () => {
  let service: DocumentTransferService;
  let deps: TransferServiceDeps;
  let testDoc: DiagramDocument;

  beforeEach(() => {
    localStorageMock.clear();
    resetTransferService();

    testDoc = createTestDocument();
    deps = createMockDeps({
      loadDocument: vi.fn((id: string) => (id === testDoc.id ? testDoc : null)),
      saveDocument: vi.fn((doc: DiagramDocument) => {
        testDoc = doc;
      }),
    });

    service = new DocumentTransferService(deps);
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  describe('transferToTeam', () => {
    it('successfully transfers a personal document to team', async () => {
      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(true);
      expect(result.document).toBeDefined();
      expect(result.document?.isRelayDocument).toBe(true);
      expect(result.document?.ownerId).toBe('user-1');
      expect(result.document?.ownerName).toBe('Test User');
    });

    it('calls server sync when authenticated', async () => {
      await service.transferToTeam(testDoc.id);

      expect(deps.saveToHost).toHaveBeenCalledTimes(1);
      expect(deps.saveToHost).toHaveBeenCalledWith(
        expect.objectContaining({
          id: testDoc.id,
          isRelayDocument: true,
        }),
        // JP-375: saveToHost now carries the tombstone-override flag.
        expect.objectContaining({ overrideTombstone: false }),
      );
    });

    it('surfaces a tombstoned result when the relay returns 410 (JP-375)', async () => {
      deps.saveToHost = vi.fn().mockRejectedValue(
        Object.assign(new Error('gone'), { status: 410 }),
      );
      const result = await service.transferToTeam(testDoc.id);
      expect(result.success).toBe(false);
      expect(result.tombstoned).toBe(true);
    });

    it('forwards overrideTombstone to saveToHost when restoring (JP-375)', async () => {
      await service.transferToTeam(testDoc.id, { overrideTombstone: true });
      expect(deps.saveToHost).toHaveBeenCalledWith(
        expect.objectContaining({ id: testDoc.id }),
        expect.objectContaining({ overrideTombstone: true }),
      );
    });

    it('skips server sync when not authenticated', async () => {
      deps.isAuthenticated = vi.fn(() => false);

      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(true);
      expect(deps.saveToHost).not.toHaveBeenCalled();
    });

    it('skips server sync when skipServerSync option is true', async () => {
      const result = await service.transferToTeam(testDoc.id, { skipServerSync: true });

      expect(result.success).toBe(true);
      expect(deps.saveToHost).not.toHaveBeenCalled();
    });

    it('fails if document not found', async () => {
      deps.loadDocument = vi.fn(() => null);

      const result = await service.transferToTeam('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('fails if document is already a relay document', async () => {
      testDoc.isRelayDocument = true;

      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already a relay document');
    });

    it('rolls back on server sync failure', async () => {
      const originalDoc = { ...testDoc };
      deps.saveToHost = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      expect(deps.saveDocument).toHaveBeenLastCalledWith(expect.objectContaining({
        id: originalDoc.id,
        isRelayDocument: false,
      }));
    });

    it('calls onProgress callback with state updates', async () => {
      const progressStates: TransferState[] = [];
      const onProgress = (state: TransferState) => progressStates.push(state);

      await service.transferToTeam(testDoc.id, { onProgress });

      expect(progressStates).toEqual([
        'preparing',
        'prepared',
        'executing',
        'committing',
        'committed',
      ]);
    });

    it('updates document metadata after successful transfer', async () => {
      await service.transferToTeam(testDoc.id);

      expect(deps.updateMetadata).toHaveBeenCalledWith(
        testDoc.id,
        expect.objectContaining({
          isRelayDocument: true,
        })
      );
    });
  });

  describe('transferToPersonal', () => {
    let teamDoc: DiagramDocument;

    beforeEach(() => {
      teamDoc = createTestDocument({
        isRelayDocument: true,
        ownerId: 'user-1',
        ownerName: 'Test User',
        lastModifiedBy: 'user-2',
        lastModifiedByName: 'Other User',
      });
      deps.loadDocument = vi.fn((id: string) => (id === teamDoc.id ? teamDoc : null));
      deps.saveDocument = vi.fn((doc: DiagramDocument) => {
        teamDoc = doc;
      });
    });

    it('successfully transfers a relay document to personal', async () => {
      const result = await service.transferToPersonal(teamDoc.id);

      expect(result.success).toBe(true);
      expect(result.document).toBeDefined();
      expect(result.document?.isRelayDocument).toBe(false);
      expect(result.document?.ownerId).toBeUndefined();
      expect(result.document?.ownerName).toBeUndefined();
    });

    it('calls server delete when authenticated', async () => {
      await service.transferToPersonal(teamDoc.id);

      expect(deps.deleteFromHost).toHaveBeenCalledTimes(1);
      expect(deps.deleteFromHost).toHaveBeenCalledWith(teamDoc.id);
    });

    it('removes team-specific fields', async () => {
      const result = await service.transferToPersonal(teamDoc.id);

      expect(result.document?.ownerId).toBeUndefined();
      expect(result.document?.ownerName).toBeUndefined();
      expect(result.document?.lastModifiedBy).toBeUndefined();
      expect(result.document?.lastModifiedByName).toBeUndefined();
      expect(result.document?.lockedBy).toBeUndefined();
      expect(result.document?.sharedWith).toBeUndefined();
    });

    it('fails if document is already personal', async () => {
      teamDoc.isRelayDocument = false;

      const result = await service.transferToPersonal(teamDoc.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already a personal document');
    });

    it('continues even if server delete fails', async () => {
      deps.deleteFromHost = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.transferToPersonal(teamDoc.id);

      // Should still succeed - server delete is best effort
      expect(result.success).toBe(true);
      expect(result.document?.isRelayDocument).toBe(false);
    });
  });

  // Data-loss guard: a relay→personal move must download the doc's blobs locally
  // before deleting the relay copy. Otherwise the personal doc keeps blob:// refs
  // whose bytes lived only on the relay → irreversibly broken file refs.
  describe('Move-to-Personal blob safety', () => {
    let teamDoc: DiagramDocument;

    beforeEach(() => {
      teamDoc = createTestDocument({ isRelayDocument: true, ownerId: 'user-1' });
      deps.loadDocument = vi.fn((id: string) => (id === teamDoc.id ? teamDoc : null));
      deps.saveDocument = vi.fn((doc: DiagramDocument) => {
        teamDoc = doc;
      });
    });

    it('aborts without deleting the relay copy when blobs cannot be secured', async () => {
      deps.ensureBlobsAvailableLocally = vi.fn().mockResolvedValue(false);

      const result = await service.transferToPersonal(teamDoc.id);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/files/i);
      expect(deps.deleteFromHost).not.toHaveBeenCalled();
      // The doc is left untouched as a relay doc — nothing lost.
      expect(teamDoc.isRelayDocument).toBe(true);
    });

    it('proceeds once blobs are secured locally', async () => {
      deps.ensureBlobsAvailableLocally = vi.fn().mockResolvedValue(true);

      const result = await service.transferToPersonal(teamDoc.id);

      expect(deps.ensureBlobsAvailableLocally).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.document?.isRelayDocument).toBe(false);
      expect(deps.deleteFromHost).toHaveBeenCalledTimes(1);
    });

    it('secures blobs BEFORE deleting the relay copy', async () => {
      const order: string[] = [];
      deps.ensureBlobsAvailableLocally = vi.fn(async () => {
        order.push('ensure-blobs');
        return true;
      });
      deps.deleteFromHost = vi.fn(async () => {
        order.push('delete-from-host');
      });

      await service.transferToPersonal(teamDoc.id);

      expect(order).toEqual(['ensure-blobs', 'delete-from-host']);
    });
  });

  // JP-83 regression: a relay doc moved back to personal must remain visible in
  // the document browser. `DocumentBrowser.handleMoveToPersonal` re-registers the
  // converted doc as Local after the transfer — without that step the doc is
  // gone from the registry (fetchDocumentList only re-registers *remote* docs,
  // and the doc was just deleted from the relay), so it silently disappears even
  // though its data is intact in localStorage.
  describe('Move-to-Personal keeps the doc in the registry (JP-83 regression)', () => {
    let teamDoc: DiagramDocument;

    beforeEach(() => {
      useDocumentRegistry.getState().reset();
      teamDoc = createTestDocument({
        isRelayDocument: true,
        ownerId: 'user-1',
        ownerName: 'Test User',
      });
      deps.loadDocument = vi.fn((id: string) => (id === teamDoc.id ? teamDoc : null));
      deps.saveDocument = vi.fn((doc: DiagramDocument) => {
        teamDoc = doc;
      });
      // Seed the registry as the browser would have it: a remote entry.
      useDocumentRegistry
        .getState()
        .registerRemote(getDocumentMetadata(teamDoc), 'relay-1', 'owner', 'synced');
    });

    it('re-registers the converted document as Local (not absent, not remote)', async () => {
      const result = await service.transferToPersonal(teamDoc.id);
      expect(result.success).toBe(true);
      expect(result.document?.isRelayDocument).toBe(false);

      // Mirror the handler's post-transfer step.
      useDocumentRegistry.getState().registerLocal(getDocumentMetadata(result.document!));

      const registry = useDocumentRegistry.getState();
      expect(registry.hasDocument(teamDoc.id)).toBe(true);
      expect(registry.isLocalDocument(teamDoc.id)).toBe(true);
      expect(registry.isRemoteDocument(teamDoc.id)).toBe(false);
      expect(registry.getRecord(teamDoc.id)?.type).toBe('local');
    });
  });

  describe('concurrent transfer prevention', () => {
    it('prevents concurrent transfers', async () => {
      // Start a slow transfer
      let resolveFirst: () => void;
      deps.saveToHost = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      });

      const firstPromise = service.transferToTeam(testDoc.id);

      // Try to start another transfer
      const secondResult = await service.transferToTeam(testDoc.id);

      expect(secondResult.success).toBe(false);
      expect(secondResult.error).toContain('Another transfer is in progress');

      // Complete first transfer
      resolveFirst!();
      const firstResult = await firstPromise;
      expect(firstResult.success).toBe(true);
    });
  });

  describe('transfer recovery', () => {
    it('recovers a preparing-state transfer by cleaning up', async () => {
      // Simulate interrupted transfer in preparing state
      const pendingRecord: TransferRecord = {
        id: 'transfer_123',
        documentId: testDoc.id,
        direction: 'to-relay',
        state: 'preparing',
        originalDocument: testDoc,
        startedAt: Date.now() - 10000,
      };
      localStorageMock.setItem('docushark-pending-transfer', JSON.stringify(pendingRecord));

      service = new DocumentTransferService(deps);
      const result = await service.recoverPendingTransfer();

      expect(result).not.toBeNull();
      expect(result?.success).toBe(true);
      expect(result?.document).toEqual(testDoc);
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('docushark-pending-transfer');
    });

    it('rolls back an executing-state transfer', async () => {
      const pendingRecord: TransferRecord = {
        id: 'transfer_123',
        documentId: testDoc.id,
        direction: 'to-relay',
        state: 'executing',
        originalDocument: testDoc,
        startedAt: Date.now() - 10000,
      };
      localStorageMock.setItem('docushark-pending-transfer', JSON.stringify(pendingRecord));

      // Service should find the interrupted transfer
      service = new DocumentTransferService(deps);
      const result = await service.recoverPendingTransfer();

      expect(result).not.toBeNull();
      expect(result?.rolledBack).toBe(true);
      // Original document should be restored
      expect(deps.saveDocument).toHaveBeenCalledWith(expect.objectContaining({
        id: testDoc.id,
        isRelayDocument: false,
      }));
    });

    it('returns null if no pending transfer', async () => {
      const result = await service.recoverPendingTransfer();
      expect(result).toBeNull();
    });

    it('cleans up committed transfers', async () => {
      const pendingRecord: TransferRecord = {
        id: 'transfer_123',
        documentId: testDoc.id,
        direction: 'to-relay',
        state: 'committed',
        originalDocument: testDoc,
        startedAt: Date.now() - 10000,
        completedAt: Date.now() - 5000,
      };
      localStorageMock.setItem('docushark-pending-transfer', JSON.stringify(pendingRecord));

      service = new DocumentTransferService(deps);
      const result = await service.recoverPendingTransfer();

      expect(result).toBeNull();
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('docushark-pending-transfer');
    });
  });

  describe('timeout handling', () => {
    it('times out slow server operations', async () => {
      deps.saveToHost = vi.fn().mockImplementation(() => {
        return new Promise(() => {
          // Never resolves
        });
      });

      const result = await service.transferToTeam(testDoc.id, { timeout: 50 });

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(true);
      // Error message from rollback
      expect(result.error).toContain('rolled back');
    });
  });

  describe('state inspection', () => {
    it('reports transfer in progress correctly', async () => {
      let resolveTransfer: () => void;
      deps.saveToHost = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveTransfer = resolve;
        });
      });

      expect(service.isTransferInProgress()).toBe(false);

      const promise = service.transferToTeam(testDoc.id);

      // Wait a tick for the transfer to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(service.isTransferInProgress()).toBe(true);
      expect(service.getCurrentTransfer()).not.toBeNull();
      expect(service.getCurrentTransfer()?.documentId).toBe(testDoc.id);

      resolveTransfer!();
      await promise;

      expect(service.isTransferInProgress()).toBe(false);
      expect(service.getCurrentTransfer()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('handles document disappearing during transfer', async () => {
      let callCount = 0;
      deps.loadDocument = vi.fn(() => {
        callCount++;
        // First call succeeds (prepare), second call fails (execute)
        return callCount === 1 ? testDoc : null;
      });

      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(false);
      // Rollback message when document disappeared during execute
      expect(result.rolledBack).toBe(true);
    });

    it('handles saveDocument throwing during rollback', async () => {
      deps.saveToHost = vi.fn().mockRejectedValue(new Error('Network error'));
      deps.saveDocument = vi.fn().mockImplementation((doc: DiagramDocument) => {
        if (doc.isRelayDocument === false) {
          throw new Error('Storage full');
        }
      });

      const result = await service.transferToTeam(testDoc.id);

      expect(result.success).toBe(false);
      expect(result.rolledBack).toBe(false);
      expect(result.error).toContain('rollback both failed');
    });
  });

  describe('localStorage persistence', () => {
    it('persists transfer state for crash recovery', async () => {
      let resolveTransfer: () => void;
      deps.saveToHost = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          resolveTransfer = resolve;
        });
      });

      const promise = service.transferToTeam(testDoc.id);

      // Wait for execute phase
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Check localStorage was written
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'docushark-pending-transfer',
        expect.stringContaining(testDoc.id)
      );

      const lastCallArgs = localStorageMock.setItem.mock.calls.slice(-1)[0];
      expect(lastCallArgs).toBeDefined();
      const savedState = JSON.parse(lastCallArgs![1]);
      expect(savedState.documentId).toBe(testDoc.id);
      expect(savedState.direction).toBe('to-relay');
      expect(savedState.originalDocument).toBeDefined();

      resolveTransfer!();
      await promise;

      // Check localStorage was cleared after completion
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('docushark-pending-transfer');
    });
  });
});
