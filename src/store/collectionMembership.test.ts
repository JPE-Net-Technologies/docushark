import { describe, it, expect } from 'vitest';
import { stampCollectionMembership } from './collectionMembership';
import type { DiagramDocument } from '../types/Document';

function doc(extra: Partial<DiagramDocument> = {}): DiagramDocument {
  return { id: 'd1', name: 'Doc', ...extra } as DiagramDocument;
}

describe('stampCollectionMembership (JP-159 clobber guard)', () => {
  it('stamps collectionId when the doc is assigned', () => {
    const out = stampCollectionMembership(doc(), 'c1', true);
    expect(out.collectionId).toBe('c1');
  });

  it('overrides a stale body collectionId with the store assignment', () => {
    const out = stampCollectionMembership(doc({ collectionId: 'old' }), 'c2', true);
    expect(out.collectionId).toBe('c2');
  });

  it('returns the same object when already matching (no needless clone)', () => {
    const d = doc({ collectionId: 'c1' });
    expect(stampCollectionMembership(d, 'c1', true)).toBe(d);
  });

  it('strips a stale membership when unassigned AND listed (honours unassign)', () => {
    const out = stampCollectionMembership(doc({ collectionId: 'c1' }), undefined, true);
    expect(out.collectionId).toBeUndefined();
  });

  it('preserves body membership when unassigned but NOT listed (pre-reconcile race)', () => {
    const out = stampCollectionMembership(doc({ collectionId: 'c1' }), undefined, false);
    expect(out.collectionId).toBe('c1');
  });

  it('is a no-op for an unassigned doc with no membership', () => {
    const d = doc();
    expect(stampCollectionMembership(d, undefined, true)).toBe(d);
  });
});
