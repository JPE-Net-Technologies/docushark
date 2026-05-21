import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import {
  SyncStateManager,
  getSyncStateManager,
  resetSyncStateManager,
  type SyncStateManagerOptions,
} from './SyncStateManager';
import { resetOfflineQueue } from './OfflineQueue';
import type { DiagramDocument } from '../types/Document';

// Mock stores
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: {
    getState: vi.fn(() => ({
      hasDocument: vi.fn(() => false),
      isRemoteDocument: vi.fn(() => false),
      setSyncState: vi.fn(),
      incrementPendingChanges: vi.fn(),
      resetPendingChanges: vi.fn(),
      getRemoteDocuments: vi.fn(() => []),
      convertToCached: vi.fn(),
    })),
  },
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: {
    getState: vi.fn(() => ({
      status: 'disconnected',
      host: null,
    })),
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('../storage/SyncQueueStorage', () => ({
  getSyncQueueStorage: vi.fn(() => ({
    loadAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
    saveAll: vi.fn().mockResolvedValue({ success: true }),
    clearAll: vi.fn().mockResolvedValue({ success: true }),
  })),
}));

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

// Mock provider
function createMockProvider(ready = true) {
  return {
    isReady: vi.fn(() => ready),
    saveDocument: vi.fn().mockResolvedValue(undefined),
    deleteDocument: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SyncStateManager', () => {
  let manager: SyncStateManager;
  let options: SyncStateManagerOptions;

  beforeEach(() => {
    resetOfflineQueue();
    options = {
      maxRetries: 3,
      autoProcessOnReconnect: false,
      onSyncStart: vi.fn(),
      onSyncComplete: vi.fn(),
      onOperationQueued: vi.fn(),
      onError: vi.fn(),
    };
    manager = new SyncStateManager(options);
  });

  afterEach(() => {
    manager.destroy();
  });

  describe('initialization', () => {
    it('creates with default options', () => {
      const defaultManager = new SyncStateManager();
      const state = defaultManager.getState();

      expect(state.initialized).toBe(false);
      expect(state.syncing).toBe(false);
      expect(state.pendingCount).toBe(0);
      defaultManager.destroy();
    });

    it('initializes successfully', async () => {
      await manager.initialize();
      const state = manager.getState();

      expect(state.initialized).toBe(true);
    });

    it('skips re-initialization', async () => {
      await manager.initialize();
      await manager.initialize();

      expect(manager.getState().initialized).toBe(true);
    });
  });

  describe('provider management', () => {
    it('sets and gets provider', () => {
      const provider = createMockProvider();

      manager.setProvider(provider as never);
      expect(manager.getProvider()).toBe(provider);
    });

    it('clears provider with null', () => {
      const provider = createMockProvider();

      manager.setProvider(provider as never);
      manager.setProvider(null);

      expect(manager.getProvider()).toBeNull();
    });
  });

  describe('queueSave', () => {
    it('queues save operation', () => {
      const doc = createTestDocument('doc-1', 'Test');
      const op = manager.queueSave(doc, 'host-1');

      expect(op.type).toBe('save');
      expect(op.documentId).toBe('doc-1');
      expect(options.onOperationQueued).toHaveBeenCalledWith(op);
    });

    it('reports pending operations', () => {
      const doc = createTestDocument('doc-1', 'Test');
      manager.queueSave(doc, 'host-1');

      expect(manager.hasPendingChanges('doc-1')).toBe(true);
      expect(manager.hasPendingChanges('doc-2')).toBe(false);
    });

    it('updates pending count after initialization', async () => {
      await manager.initialize();
      manager.queueSave(createTestDocument('doc-1', 'Test 1'), 'host-1');
      manager.queueSave(createTestDocument('doc-2', 'Test 2'), 'host-1');

      // Pending count is tracked by queue onChange which fires on queueSave
      expect(manager.getPendingCount()).toBe(2);
    });
  });

  describe('queueDelete', () => {
    it('queues delete operation', () => {
      const op = manager.queueDelete('doc-1', 'host-1');

      expect(op.type).toBe('delete');
      expect(op.documentId).toBe('doc-1');
      expect(options.onOperationQueued).toHaveBeenCalledWith(op);
    });
  });

  describe('processQueue', () => {
    it('returns empty when no provider', async () => {
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      const results = await manager.processQueue();

      expect(results).toEqual([]);
    });

    it('returns empty when provider not ready', async () => {
      const provider = createMockProvider(false);
      manager.setProvider(provider as never);
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      const results = await manager.processQueue();

      expect(results).toEqual([]);
    });

    it('processes queue when provider ready', async () => {
      const provider = createMockProvider();
      manager.setProvider(provider as never);

      const doc = createTestDocument('doc-1', 'Test');
      manager.queueSave(doc, 'host-1');

      const results = await manager.processQueue();

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);
      expect(provider.saveDocument).toHaveBeenCalledWith(doc);
      expect(options.onSyncStart).toHaveBeenCalled();
      expect(options.onSyncComplete).toHaveBeenCalledWith(results);
    });

    it('processes delete operations', async () => {
      const provider = createMockProvider();
      manager.setProvider(provider as never);
      manager.queueDelete('doc-1', 'host-1');

      const results = await manager.processQueue();

      expect(results).toHaveLength(1);
      expect(provider.deleteDocument).toHaveBeenCalledWith('doc-1');
    });

    it('prevents concurrent processing', async () => {
      const provider = createMockProvider();
      (provider.saveDocument as Mock).mockImplementation(
        () => new Promise((r) => setTimeout(r, 50))
      );
      manager.setProvider(provider as never);
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      const [results1, results2] = await Promise.all([
        manager.processQueue(),
        manager.processQueue(),
      ]);

      // One should succeed, one should return empty
      expect(results1.length + results2.length).toBe(1);
    });

    it('updates lastSyncAt on success', async () => {
      const provider = createMockProvider();
      manager.setProvider(provider as never);
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      await manager.processQueue();
      const state = manager.getState();

      expect(state.lastSyncAt).toBeDefined();
      expect(state.lastSyncAt).toBeGreaterThan(0);
    });

    it('handles errors gracefully', async () => {
      const provider = createMockProvider();
      (provider.saveDocument as Mock).mockRejectedValue(new Error('Network error'));
      manager.setProvider(provider as never);
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      const results = await manager.processQueue();

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(manager.getState().syncing).toBe(false);
    });
  });

  describe('processQueueForHost', () => {
    it('returns empty when no provider', async () => {
      manager.queueSave(createTestDocument('doc-1', 'Test'), 'host-1');

      const results = await manager.processQueueForHost('host-1');

      expect(results).toEqual([]);
    });

    it('only processes operations for specified host', async () => {
      const provider = createMockProvider();
      manager.setProvider(provider as never);

      manager.queueSave(createTestDocument('doc-1', 'Test 1'), 'host-1');
      manager.queueSave(createTestDocument('doc-2', 'Test 2'), 'host-2');

      const results = await manager.processQueueForHost('host-1');

      expect(results).toHaveLength(1);
      expect(results[0]?.operation.relayId).toBe('host-1');
      // host-2 operation should still be pending
      expect(manager.hasPendingChanges('doc-2')).toBe(true);
    });
  });

  describe('destroy', () => {
    it('cleans up subscriptions', async () => {
      await manager.initialize();

      manager.destroy();
      const state = manager.getState();

      expect(state.initialized).toBe(false);
      expect(manager.getProvider()).toBeNull();
    });

    it('can be called multiple times safely', () => {
      manager.destroy();
      manager.destroy();

      expect(manager.getState().initialized).toBe(false);
    });
  });

  describe('clearPersistedQueue', () => {
    it('clears storage without error', async () => {
      // Just verify no error is thrown - storage is mocked
      await expect(manager.clearPersistedQueue()).resolves.not.toThrow();
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    resetSyncStateManager();
    resetOfflineQueue();
  });

  afterEach(() => {
    resetSyncStateManager();
  });

  it('getSyncStateManager returns singleton', () => {
    const manager1 = getSyncStateManager();
    const manager2 = getSyncStateManager();

    expect(manager1).toBe(manager2);
  });

  it('resetSyncStateManager destroys and creates new instance', () => {
    const manager1 = getSyncStateManager();

    resetSyncStateManager();

    const manager2 = getSyncStateManager();
    expect(manager1).not.toBe(manager2);
  });

  it('passes options to first creation only', () => {
    const onError = vi.fn();
    const manager1 = getSyncStateManager({ onError });

    resetSyncStateManager();

    const manager2 = getSyncStateManager();
    expect(manager1).not.toBe(manager2);
  });
});
