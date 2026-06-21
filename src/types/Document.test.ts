import { describe, it, expect } from 'vitest';
import { createDocument, getDocumentMetadata } from './Document';

describe('getDocumentMetadata pageCount (JP-349)', () => {
  it('counts canvas-only documents as before', () => {
    const doc = createDocument('Doc', 'd1', 'p1');
    expect(getDocumentMetadata(doc).pageCount).toBe(1);
  });

  it('counts canvas + prose pages combined', () => {
    const doc = createDocument('Doc', 'd1', 'p1');
    doc.richTextPages = {
      pages: {},
      pageOrder: ['r1', 'r2', 'r3'],
      activePageId: 'r1',
    };
    // 1 canvas + 3 prose
    expect(getDocumentMetadata(doc).pageCount).toBe(4);
  });

  it('treats absent richTextPages as zero prose pages', () => {
    const doc = createDocument('Doc', 'd1', 'p1');
    doc.pageOrder = ['p1', 'p2'];
    delete doc.richTextPages;
    expect(getDocumentMetadata(doc).pageCount).toBe(2);
  });
});
