/**
 * JP-423 — the `queueSave` seam applies `serializeDocForRest`.
 *
 * A queued body IS a REST body (it replays as one), so the withhold applies at
 * enqueue time — reflecting the pending markers as they were when the edit
 * happened, not whenever the replay later fires.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: {
    getState: vi.fn(() => ({
      hasDocument: vi.fn(() => false),
      isRemoteDocument: vi.fn(() => false),
      setSyncState: vi.fn(),
      incrementPendingChanges: vi.fn(),
    })),
  },
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: {
    getState: vi.fn(() => ({ status: 'disconnected', host: null })),
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

import { SyncStateManager } from './SyncStateManager';
import { resetOfflineQueue } from './OfflineQueue';
import { usePendingSyncPages } from '../store/pendingSyncPages';
import type { DiagramDocument } from '../types/Document';

function makeDoc(): DiagramDocument {
  return {
    id: 'doc-1',
    name: 'Doc',
    pages: {},
    pageOrder: [],
    activePageId: '',
    createdAt: 0,
    modifiedAt: 0,
    version: 1,
    richTextPages: {
      pages: {
        'rt-pending': {
          id: 'rt-pending',
          name: 'Pending',
          content: '<p>offline-created</p>',
          createdAt: 0,
          modifiedAt: 0,
        },
      },
      pageOrder: ['rt-pending'],
      activePageId: 'rt-pending',
    },
  } as unknown as DiagramDocument;
}

describe('queueSave seam (JP-423)', () => {
  beforeEach(() => {
    resetOfflineQueue();
    usePendingSyncPages.setState({ pending: {} });
  });

  it('enqueues the withheld body when a page is pending', () => {
    usePendingSyncPages.getState().markPending('rt-pending', 'doc-1');
    const manager = new SyncStateManager({ autoProcessOnReconnect: false });

    const op = manager.queueSave(makeDoc(), 'relay-1');

    expect(op.type).toBe('save');
    if (op.type === 'save') {
      expect(op.document.richTextPages?.pages['rt-pending']?.content).toBe('');
    }
  });

  it('enqueues the body unchanged when nothing is pending', () => {
    const manager = new SyncStateManager({ autoProcessOnReconnect: false });

    const op = manager.queueSave(makeDoc(), 'relay-1');

    if (op.type === 'save') {
      expect(op.document.richTextPages?.pages['rt-pending']?.content).toBe(
        '<p>offline-created</p>',
      );
    }
  });
});
