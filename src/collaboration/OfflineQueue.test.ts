import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OfflineQueue,
  getOfflineQueue,
  resetOfflineQueue,
  type QueuedOperation,
  type QueuedSaveOperation,
} from './OfflineQueue';
import type { DiagramDocument } from '../types/Document';

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

describe('OfflineQueue', () => {
  let queue: OfflineQueue;

  beforeEach(() => {
    queue = new OfflineQueue();
  });

  describe('enqueueSave', () => {
    it('queues a save operation', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const op = queue.enqueueSave(doc, 'host-1');

      expect(op.type).toBe('save');
      expect(op.documentId).toBe('doc-1');
      expect((op as QueuedSaveOperation).document).toBe(doc);
      expect(op.relayId).toBe('host-1');
      expect(op.retryCount).toBe(0);
      expect(queue.isEmpty()).toBe(false);
    });

    it('replaces existing save for same document (last-write-wins)', () => {
      const doc1 = createTestDocument('doc-1', 'Version 1');
      const doc2 = createTestDocument('doc-1', 'Version 2');

      queue.enqueueSave(doc1, 'host-1');
      queue.enqueueSave(doc2, 'host-1');

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect((all[0] as QueuedSaveOperation).document.name).toBe('Version 2');
    });

    it('queues multiple documents separately', () => {
      const doc1 = createTestDocument('doc-1', 'Doc 1');
      const doc2 = createTestDocument('doc-2', 'Doc 2');

      queue.enqueueSave(doc1, 'host-1');
      queue.enqueueSave(doc2, 'host-1');

      expect(queue.getAll()).toHaveLength(2);
    });

    it('generates unique operation IDs', () => {
      const doc1 = createTestDocument('doc-1', 'Doc 1');
      const doc2 = createTestDocument('doc-2', 'Doc 2');

      const op1 = queue.enqueueSave(doc1, 'host-1');
      const op2 = queue.enqueueSave(doc2, 'host-1');

      expect(op1.id).not.toBe(op2.id);
      expect(op1.id).toMatch(/^op_\d+_[a-z0-9]+$/);
    });
  });

  describe('enqueueDelete', () => {
    it('queues a delete operation', () => {
      const op = queue.enqueueDelete('doc-1', 'host-1');

      expect(op.type).toBe('delete');
      expect(op.documentId).toBe('doc-1');
      expect(op.relayId).toBe('host-1');
      expect(queue.isEmpty()).toBe(false);
    });

    it('removes pending save for same document', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      queue.enqueueSave(doc, 'host-1');
      queue.enqueueDelete('doc-1', 'host-1');

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.type).toBe('delete');
    });
  });

  describe('removeByDocumentId', () => {
    it('removes all operations for a document', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      queue.enqueueSave(doc, 'host-1');
      queue.enqueueDelete('doc-2', 'host-1');

      queue.removeByDocumentId('doc-1');

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.documentId).toBe('doc-2');
    });
  });

  describe('remove', () => {
    it('removes operation by ID', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const op = queue.enqueueSave(doc, 'host-1');

      const removed = queue.remove(op.id);

      expect(removed).toBe(true);
      expect(queue.isEmpty()).toBe(true);
    });

    it('returns false for non-existent ID', () => {
      expect(queue.remove('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all operations', () => {
      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueSave(createTestDocument('doc-2', 'Doc 2'), 'host-1');
      queue.enqueueDelete('doc-3', 'host-1');

      queue.clear();

      expect(queue.isEmpty()).toBe(true);
    });
  });

  describe('clearByHost', () => {
    it('removes operations for specific host only', () => {
      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueSave(createTestDocument('doc-2', 'Doc 2'), 'host-2');
      queue.enqueueDelete('doc-3', 'host-1');

      queue.clearByHost('host-1');

      const all = queue.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.relayId).toBe('host-2');
    });
  });

  describe('processAll', () => {
    it('processes all operations in timestamp order', async () => {
      const processedOrder: string[] = [];
      const processor = vi.fn().mockImplementation(async (op: QueuedOperation) => {
        processedOrder.push(op.documentId);
      });

      // Queue with slight delays to get different timestamps
      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueSave(createTestDocument('doc-2', 'Doc 2'), 'host-1');
      queue.enqueueDelete('doc-3', 'host-1');

      const results = await queue.processAll(processor);

      expect(results).toHaveLength(3);
      expect(processor).toHaveBeenCalledTimes(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(queue.isEmpty()).toBe(true);
    });

    it('removes successful operations from queue', async () => {
      const processor = vi.fn().mockResolvedValue(undefined);

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      await queue.processAll(processor);

      expect(queue.isEmpty()).toBe(true);
    });

    it('keeps failed operations in queue', async () => {
      const processor = vi.fn().mockRejectedValue(new Error('Network error'));

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      const results = await queue.processAll(processor, 1); // Max 1 retry

      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toBe('Network error');
      // Operation stays in queue after failure
      expect(queue.isEmpty()).toBe(false);
    });

    it('tracks retry count on failures', async () => {
      let callCount = 0;
      const processor = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error('Fail');
      });

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      await queue.processAll(processor, 3);

      // Should only call once per processAll (retry happens on next processAll call)
      expect(callCount).toBe(1);
      const op = queue.getByDocumentId('doc-1');
      expect(op?.retryCount).toBe(1);
      expect(op?.lastError).toBe('Fail');
    });

    it('prevents concurrent processing', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const processor = vi.fn().mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
      });

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');

      // Try to process twice concurrently
      const promise1 = queue.processAll(processor);
      const promise2 = queue.processAll(processor);

      const [results1, results2] = await Promise.all([promise1, promise2]);

      // Second call should return empty (already processing)
      expect(results1.length + results2.length).toBe(1);
    });

    it('returns empty array when queue is empty', async () => {
      const processor = vi.fn();
      const results = await queue.processAll(processor);

      expect(results).toEqual([]);
      expect(processor).not.toHaveBeenCalled();
    });
  });

  describe('processForHost', () => {
    it('only processes operations for specified host', async () => {
      const processor = vi.fn().mockResolvedValue(undefined);

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueSave(createTestDocument('doc-2', 'Doc 2'), 'host-2');
      queue.enqueueDelete('doc-3', 'host-1');

      const results = await queue.processForHost('host-1', processor);

      expect(results).toHaveLength(2);
      expect(queue.getAll()).toHaveLength(1);
      expect(queue.getAll()[0]?.relayId).toBe('host-2');
    });
  });

  describe('query methods', () => {
    beforeEach(() => {
      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueSave(createTestDocument('doc-2', 'Doc 2'), 'host-2');
      queue.enqueueDelete('doc-3', 'host-1');
    });

    it('getAll returns all operations', () => {
      expect(queue.getAll()).toHaveLength(3);
    });

    it('getOperationsSorted returns sorted by timestamp', () => {
      const sorted = queue.getOperationsSorted();
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]!.timestamp).toBeGreaterThanOrEqual(sorted[i - 1]!.timestamp);
      }
    });

    it('getByDocumentId returns correct operation', () => {
      const op = queue.getByDocumentId('doc-1');
      expect(op?.documentId).toBe('doc-1');
      expect(op?.type).toBe('save');
    });

    it('getByDocumentId returns undefined for missing', () => {
      expect(queue.getByDocumentId('nonexistent')).toBeUndefined();
    });

    it('getByHost returns operations for host', () => {
      const ops = queue.getByHost('host-1');
      expect(ops).toHaveLength(2);
      expect(ops.every((op) => op.relayId === 'host-1')).toBe(true);
    });

    it('hasPendingOperations returns correct status', () => {
      expect(queue.hasPendingOperations('doc-1')).toBe(true);
      expect(queue.hasPendingOperations('doc-99')).toBe(false);
    });

    it('getStats returns correct statistics', () => {
      const stats = queue.getStats();

      expect(stats.total).toBe(3);
      expect(stats.saves).toBe(2);
      expect(stats.deletes).toBe(1);
      expect(stats.oldestTimestamp).toBeDefined();
    });

    it('isEmpty returns correct status', () => {
      expect(queue.isEmpty()).toBe(false);
      queue.clear();
      expect(queue.isEmpty()).toBe(true);
    });

    it('isProcessing returns correct status', () => {
      expect(queue.isProcessing()).toBe(false);
    });
  });

  describe('onChange', () => {
    it('calls callback on enqueue', () => {
      const callback = vi.fn();
      queue.onChange(callback);

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('calls callback on remove', () => {
      const doc = createTestDocument('doc-1', 'Doc 1');
      const op = queue.enqueueSave(doc, 'host-1');

      const callback = vi.fn();
      queue.onChange(callback);

      queue.remove(op.id);

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('returns unsubscribe function', () => {
      const callback = vi.fn();
      const unsubscribe = queue.onChange(callback);

      unsubscribe();

      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('serialization', () => {
    it('toJSON returns all operations', () => {
      queue.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');
      queue.enqueueDelete('doc-2', 'host-1');

      const json = queue.toJSON();

      expect(json).toHaveLength(2);
      expect(json[0]?.documentId).toBeDefined();
    });

    it('fromJSON restores operations', () => {
      const doc = createTestDocument('doc-1', 'Test Doc');
      const operations: QueuedOperation[] = [
        {
          id: 'op-1',
          type: 'save',
          documentId: 'doc-1',
          document: doc,
          timestamp: Date.now(),
          retryCount: 0,
          relayId: 'host-1',
        },
        {
          id: 'op-2',
          type: 'delete',
          documentId: 'doc-2',
          timestamp: Date.now(),
          retryCount: 1,
          relayId: 'host-1',
        },
      ];

      queue.fromJSON(operations);

      expect(queue.getAll()).toHaveLength(2);
      expect(queue.getByDocumentId('doc-1')?.type).toBe('save');
      expect(queue.getByDocumentId('doc-2')?.retryCount).toBe(1);
    });

    it('fromJSON clears existing operations', () => {
      queue.enqueueSave(createTestDocument('existing', 'Existing'), 'host-1');

      queue.fromJSON([]);

      expect(queue.isEmpty()).toBe(true);
    });
  });
});

describe('Singleton functions', () => {
  beforeEach(() => {
    resetOfflineQueue();
  });

  it('getOfflineQueue returns singleton', () => {
    const queue1 = getOfflineQueue();
    const queue2 = getOfflineQueue();

    expect(queue1).toBe(queue2);
  });

  it('resetOfflineQueue creates new instance', () => {
    const queue1 = getOfflineQueue();
    queue1.enqueueSave(createTestDocument('doc-1', 'Doc 1'), 'host-1');

    resetOfflineQueue();

    const queue2 = getOfflineQueue();
    expect(queue2.isEmpty()).toBe(true);
    expect(queue1).not.toBe(queue2);
  });
});
