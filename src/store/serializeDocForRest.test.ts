/**
 * JP-423 — `serializeDocForRest` contract.
 *
 * The one blessed REST-body transform: blanks pending-sync pages' prose
 * (JP-335 withhold) and is where future sanitization composes. The contract
 * the seams rely on: idempotent, non-mutating, identity when nothing pends.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { serializeDocForRest } from './serializeDocForRest';
import { usePendingSyncPages } from './pendingSyncPages';
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
    blobReferences: [],
    richTextPages: {
      pages: {
        'rt-a': { id: 'rt-a', name: 'A', content: '<p>alpha</p>', createdAt: 0, modifiedAt: 0 },
        'rt-b': { id: 'rt-b', name: 'B', content: '<p>beta</p>', createdAt: 0, modifiedAt: 0 },
      },
      pageOrder: ['rt-a', 'rt-b'],
      activePageId: 'rt-a',
    },
  } as unknown as DiagramDocument;
}

describe('serializeDocForRest (JP-423)', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
  });

  it('blanks a pending page\'s prose and leaves others untouched', () => {
    usePendingSyncPages.getState().markPending('rt-a', 'doc-1');

    const out = serializeDocForRest(makeDoc());

    expect(out.richTextPages?.pages['rt-a']?.content).toBe('');
    expect(out.richTextPages?.pages['rt-b']?.content).toBe('<p>beta</p>');
  });

  it('carries tags through the REST choke point untouched (JP-388)', () => {
    const doc = makeDoc();
    doc.tags = ['alpha', 'beta'];
    // With a pending page (the cloning path) AND without — both must keep tags.
    expect(serializeDocForRest(doc).tags).toEqual(['alpha', 'beta']);
    usePendingSyncPages.setState({ pending: { 'rt-a': 'doc-1' } });
    expect(serializeDocForRest(doc).tags).toEqual(['alpha', 'beta']);
  });

  it('returns the input by reference when nothing is pending', () => {
    const doc = makeDoc();
    expect(serializeDocForRest(doc)).toBe(doc);
  });

  it('is idempotent', () => {
    usePendingSyncPages.getState().markPending('rt-a', 'doc-1');

    const once = serializeDocForRest(makeDoc());
    const twice = serializeDocForRest(once);

    expect(twice).toEqual(once);
  });

  it('does not mutate the input document', () => {
    usePendingSyncPages.getState().markPending('rt-a', 'doc-1');
    const doc = makeDoc();

    serializeDocForRest(doc);

    expect(doc.richTextPages?.pages['rt-a']?.content).toBe('<p>alpha</p>');
  });
});
