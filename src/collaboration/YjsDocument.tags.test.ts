/**
 * Y.Doc tags (JP-388) — the metadata-map write path collab tag edits ride.
 * Whole-array LWW is the documented merge semantic; the `updatedAt` bump is
 * what lets the relay flatten adopt a fresh CRDT tag edit over the stored body.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';

describe('YjsDocument tags (JP-388)', () => {
  it('round-trips tags through setMetadata/getTags; absent stays undefined', () => {
    const doc = new YjsDocument();
    expect(doc.getTags()).toBeUndefined();

    doc.setMetadata({ tags: ['alpha', 'beta'], updatedAt: 42 });
    expect(doc.getTags()).toEqual(['alpha', 'beta']);
    expect(doc.getMetadata().tags).toEqual(['alpha', 'beta']);
    expect(doc.getMetadata().updatedAt).toBe(42);
  });

  it('an explicit empty list is distinct from absent (cleared vs never-set)', () => {
    const doc = new YjsDocument();
    doc.setMetadata({ tags: [] });
    expect(doc.getTags()).toEqual([]);
  });

  it('merges whole-array last-writer-wins across two docs', () => {
    const a = new YjsDocument();
    const b = new YjsDocument();

    a.setMetadata({ tags: ['from-a'], updatedAt: 1 });
    // Sync a → b, then b writes over it and syncs back.
    Y.applyUpdate(b.getDoc(), Y.encodeStateAsUpdate(a.getDoc()));
    expect(b.getTags()).toEqual(['from-a']);

    b.setMetadata({ tags: ['from-b-1', 'from-b-2'], updatedAt: 2 });
    Y.applyUpdate(a.getDoc(), Y.encodeStateAsUpdate(b.getDoc()));

    expect(a.getTags()).toEqual(['from-b-1', 'from-b-2']);
    expect(b.getTags()).toEqual(['from-b-1', 'from-b-2']);
  });

  it('drops non-string members on read (defensive against foreign writes)', () => {
    const doc = new YjsDocument();
    const metadata = doc.getDoc().getMap('metadata');
    doc.getDoc().transact(() => {
      metadata.set('tags', ['ok', 7, null, 'also-ok']);
    });
    expect(doc.getTags()).toEqual(['ok', 'also-ok']);
  });
});
