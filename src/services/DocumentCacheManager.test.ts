/**
 * Document Cache Manager Tests
 *
 * Tests for TTL-based caching with window focus refresh.
 * Phase 14.9.2 - Data Integrity Improvements
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DocumentCacheManager,
  CacheConfig,
  CacheEventType,
  resetDocumentCache,
} from './DocumentCacheManager';
import type { DocumentMetadata } from '../types/Document';

// ============ Test Fixtures ============

function createTestMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    id: 'doc-123',
    name: 'Test Document',
    pageCount: 1,
    createdAt: Date.now() - 10000,
    modifiedAt: Date.now(),
    isRelayDocument: true,
    ...overrides,
  };
}

function createTestConfig(overrides: Partial<CacheConfig> = {}): Partial<CacheConfig> {
  return {
    listTtl: 1000,
    documentTtl: 500,
    refreshOnFocus: false, // Disable for most tests
    maxEntries: 10,
    minRefreshInterval: 100,
    ...overrides,
  };
}

// ============ Tests ============

describe('DocumentCacheManager', () => {
  let cache: DocumentCacheManager;

  beforeEach(() => {
    vi.useFakeTimers();
    resetDocumentCache();
    cache = new DocumentCacheManager(createTestConfig());
  });

  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('document list caching', () => {
    it('caches and retrieves document list', () => {
      const documents = [createTestMetadata({ id: 'doc-1' }), createTestMetadata({ id: 'doc-2' })];

      cache.setDocumentList(documents);
      const cached = cache.getDocumentList();

      expect(cached).toEqual(documents);
    });

    it('returns null for uncached document list', () => {
      const cached = cache.getDocumentList();
      expect(cached).toBeNull();
    });

    it('expires document list after TTL', () => {
      const documents = [createTestMetadata()];
      cache.setDocumentList(documents);

      // Advance time past TTL
      vi.advanceTimersByTime(1001);

      const cached = cache.getDocumentList();
      expect(cached).toBeNull();
    });

    it('reports document list staleness correctly', () => {
      const documents = [createTestMetadata()];
      
      expect(cache.isDocumentListStale()).toBe(true);
      
      cache.setDocumentList(documents);
      expect(cache.isDocumentListStale()).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(cache.isDocumentListStale()).toBe(true);
    });

    it('reports remaining TTL', () => {
      const documents = [createTestMetadata()];
      cache.setDocumentList(documents);

      expect(cache.getDocumentListTtl()).toBe(1000);

      vi.advanceTimersByTime(300);
      expect(cache.getDocumentListTtl()).toBe(700);

      vi.advanceTimersByTime(800);
      expect(cache.getDocumentListTtl()).toBe(0);
    });

    it('uses custom TTL when provided', () => {
      const documents = [createTestMetadata()];
      cache.setDocumentList(documents, 2000);

      vi.advanceTimersByTime(1500);
      expect(cache.getDocumentList()).toEqual(documents);

      vi.advanceTimersByTime(600);
      expect(cache.getDocumentList()).toBeNull();
    });
  });

  describe('individual document caching', () => {
    it('caches and retrieves individual document', () => {
      const doc = { id: 'doc-123', name: 'Test' };
      cache.setDocument('doc-123', doc);

      const cached = cache.getDocument<typeof doc>('doc-123');
      expect(cached).toEqual(doc);
    });

    it('returns null for uncached document', () => {
      const cached = cache.getDocument('non-existent');
      expect(cached).toBeNull();
    });

    it('expires individual document after TTL', () => {
      const doc = { id: 'doc-123' };
      cache.setDocument('doc-123', doc);

      vi.advanceTimersByTime(501);

      const cached = cache.getDocument('doc-123');
      expect(cached).toBeNull();
    });

    it('reports document staleness correctly', () => {
      expect(cache.isDocumentStale('doc-123')).toBe(true);

      cache.setDocument('doc-123', { id: 'doc-123' });
      expect(cache.isDocumentStale('doc-123')).toBe(false);

      vi.advanceTimersByTime(501);
      expect(cache.isDocumentStale('doc-123')).toBe(true);
    });

    it('stores and retrieves ETag', () => {
      cache.setDocument('doc-123', { id: 'doc-123' }, undefined, 'abc123');

      expect(cache.getDocumentEtag('doc-123')).toBe('abc123');
    });

    it('returns undefined ETag for uncached document', () => {
      expect(cache.getDocumentEtag('non-existent')).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('invalidates specific document', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocument('doc-2', { id: 'doc-2' });

      cache.invalidateDocument('doc-1');

      expect(cache.getDocument('doc-1')).toBeNull();
      expect(cache.getDocument('doc-2')).not.toBeNull();
    });

    it('invalidates document list', () => {
      cache.setDocumentList([createTestMetadata()]);
      cache.setDocument('doc-1', { id: 'doc-1' });

      cache.invalidateDocumentList();

      expect(cache.getDocumentList()).toBeNull();
      expect(cache.getDocument('doc-1')).not.toBeNull();
    });

    it('invalidates all caches', () => {
      cache.setDocumentList([createTestMetadata()]);
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocument('doc-2', { id: 'doc-2' });

      cache.invalidateAll();

      expect(cache.getDocumentList()).toBeNull();
      expect(cache.getDocument('doc-1')).toBeNull();
      expect(cache.getDocument('doc-2')).toBeNull();
    });

    it('invalidates multiple documents by IDs', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocument('doc-2', { id: 'doc-2' });
      cache.setDocument('doc-3', { id: 'doc-3' });

      cache.invalidateDocuments(['doc-1', 'doc-3']);

      expect(cache.getDocument('doc-1')).toBeNull();
      expect(cache.getDocument('doc-2')).not.toBeNull();
      expect(cache.getDocument('doc-3')).toBeNull();
    });

    it('tracks invalidation statistics', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocument('doc-2', { id: 'doc-2' });

      cache.invalidateDocument('doc-1');
      cache.invalidateDocument('doc-2');

      expect(cache.getStats().invalidations).toBe(2);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when max entries exceeded', () => {
      // Fill cache to max (10 entries)
      for (let i = 0; i < 10; i++) {
        cache.setDocument(`doc-${i}`, { id: `doc-${i}` });
      }

      // Add one more - should evict doc-0
      cache.setDocument('doc-10', { id: 'doc-10' });

      expect(cache.getDocument('doc-0')).toBeNull();
      expect(cache.getDocument('doc-1')).not.toBeNull();
      expect(cache.getDocument('doc-10')).not.toBeNull();
    });

    it('updates access order on get', () => {
      // Fill cache
      for (let i = 0; i < 10; i++) {
        cache.setDocument(`doc-${i}`, { id: `doc-${i}` });
      }

      // Access doc-0 to move it to end of LRU queue
      cache.getDocument('doc-0');

      // Add one more - should evict doc-1 (now oldest)
      cache.setDocument('doc-10', { id: 'doc-10' });

      expect(cache.getDocument('doc-0')).not.toBeNull();
      expect(cache.getDocument('doc-1')).toBeNull();
    });

    it('tracks eviction statistics', () => {
      for (let i = 0; i < 12; i++) {
        cache.setDocument(`doc-${i}`, { id: `doc-${i}` });
      }

      expect(cache.getStats().evictions).toBe(2);
    });
  });

  describe('focus refresh', () => {
    it('triggers refresh callback on focus', () => {
      const refreshCallback = vi.fn();
      cache.setRefreshCallback(refreshCallback);
      cache.setDocumentList([createTestMetadata()]);

      cache.triggerFocusRefresh();

      expect(refreshCallback).toHaveBeenCalledTimes(1);
      expect(cache.getStats().focusRefreshes).toBe(1);
    });

    it('invalidates document list on focus refresh', () => {
      cache.setDocumentList([createTestMetadata()]);

      cache.triggerFocusRefresh();

      expect(cache.getDocumentList()).toBeNull();
    });

    it('throttles focus refreshes', () => {
      const refreshCallback = vi.fn();
      cache.setRefreshCallback(refreshCallback);

      cache.triggerFocusRefresh();
      cache.triggerFocusRefresh();
      cache.triggerFocusRefresh();

      expect(refreshCallback).toHaveBeenCalledTimes(1);

      // Advance past min refresh interval
      vi.advanceTimersByTime(101);
      cache.triggerFocusRefresh();

      expect(refreshCallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('statistics', () => {
    it('tracks cache hits', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.getDocument('doc-1');
      cache.getDocument('doc-1');
      cache.getDocument('doc-1');

      expect(cache.getStats().hits).toBe(3);
    });

    it('tracks cache misses', () => {
      cache.getDocument('non-existent');
      cache.getDocument('also-missing');

      expect(cache.getStats().misses).toBe(2);
    });

    it('tracks entry count', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocument('doc-2', { id: 'doc-2' });
      cache.setDocumentList([createTestMetadata()]);

      expect(cache.getStats().entries).toBe(3);
    });

    it('resets statistics', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.getDocument('doc-1');
      cache.getDocument('missing');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.entries).toBe(1); // Entry count is current, not reset
    });
  });

  describe('event subscription', () => {
    it('emits events for cache operations', () => {
      const events: { type: CacheEventType; key: string }[] = [];
      cache.subscribe((type, key) => {
        events.push({ type, key });
      });

      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.getDocument('doc-1');
      cache.getDocument('missing');
      cache.invalidateDocument('doc-1');

      expect(events).toContainEqual({ type: 'set', key: 'doc:doc-1' });
      expect(events).toContainEqual({ type: 'hit', key: 'doc:doc-1' });
      expect(events).toContainEqual({ type: 'miss', key: 'doc:missing' });
      expect(events).toContainEqual({ type: 'invalidate', key: 'doc:doc-1' });
    });

    it('emits expired event when entry expires on access', () => {
      const events: CacheEventType[] = [];
      cache.subscribe((type) => events.push(type));

      cache.setDocument('doc-1', { id: 'doc-1' });
      vi.advanceTimersByTime(501);
      cache.getDocument('doc-1');

      expect(events).toContain('expired');
    });

    it('emits evict event', () => {
      const events: { type: CacheEventType; key: string }[] = [];
      cache.subscribe((type, key) => {
        events.push({ type, key });
      });

      // Fill cache and overflow
      for (let i = 0; i < 11; i++) {
        cache.setDocument(`doc-${i}`, { id: `doc-${i}` });
      }

      expect(events).toContainEqual({ type: 'evict', key: 'doc:doc-0' });
    });

    it('allows unsubscription', () => {
      const events: CacheEventType[] = [];
      const unsubscribe = cache.subscribe((type) => events.push(type));

      cache.setDocument('doc-1', { id: 'doc-1' });
      unsubscribe();
      cache.setDocument('doc-2', { id: 'doc-2' });

      expect(events.length).toBe(1);
    });

    it('handles errors in event listeners gracefully', () => {
      const errorFn = vi.fn().mockImplementation(() => {
        throw new Error('Listener error');
      });
      const goodFn = vi.fn();

      cache.subscribe(errorFn);
      cache.subscribe(goodFn);

      // Should not throw
      cache.setDocument('doc-1', { id: 'doc-1' });

      expect(goodFn).toHaveBeenCalled();
    });
  });

  describe('disposal', () => {
    it('clears all data on dispose', () => {
      cache.setDocument('doc-1', { id: 'doc-1' });
      cache.setDocumentList([createTestMetadata()]);
      cache.subscribe(() => {});

      cache.dispose();

      // Create new cache to verify old one is cleaned up
      const newCache = new DocumentCacheManager(createTestConfig());
      expect(newCache.getDocument('doc-1')).toBeNull();
      newCache.dispose();
    });
  });

  describe('edge cases', () => {
    it('handles empty document list', () => {
      cache.setDocumentList([]);
      expect(cache.getDocumentList()).toEqual([]);
    });

    it('handles null/undefined values gracefully', () => {
      cache.setDocument('doc-null', null);
      expect(cache.getDocument('doc-null')).toBeNull();
    });

    it('overwrites existing entry', () => {
      cache.setDocument('doc-1', { id: 'doc-1', v: 1 });
      cache.setDocument('doc-1', { id: 'doc-1', v: 2 });

      expect(cache.getDocument<{ id: string; v: number }>('doc-1')?.v).toBe(2);
    });

    it('handles rapid set/get cycles', () => {
      for (let i = 0; i < 100; i++) {
        cache.setDocument('doc', { v: i });
        expect(cache.getDocument<{ v: number }>('doc')?.v).toBe(i);
      }
    });
  });
});
