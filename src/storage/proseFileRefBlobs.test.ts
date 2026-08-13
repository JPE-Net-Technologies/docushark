/**
 * A file chip's blob must be visible to the reference walk while the chip
 * exists, and must drop out when it is removed (JP-495 on top of JP-494).
 *
 * This is the whole reason the chip stores `blob://<hash>` rather than a bare
 * hash: the attribute is serialized inside an HTML string, and only the URI
 * grammar is discoverable there. Get it wrong and nothing fails — the bytes are
 * simply swept later, after the reader has moved on.
 */

import { describe, it, expect } from 'vitest';

import { deriveBlobReferences } from './AssetBundler';
import type { DiagramDocument } from '../types/Document';

const HASH = 'c'.repeat(64);

function docWithProse(html: string): DiagramDocument {
  return {
    id: 'd1',
    name: 'chip doc',
    pages: { p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [], connections: {} } },
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 0,
    modifiedAt: 0,
    version: 2,
    richTextPages: {
      pages: {
        rp1: { id: 'rp1', name: 'Prose', content: html, order: 0, createdAt: 0, modifiedAt: 0 },
      },
      pageOrder: ['rp1'],
      activePageId: 'rp1',
    },
  } as unknown as DiagramDocument;
}

const chip = (ref: string) =>
  `<p>See <span data-file-ref data-blob-ref="${ref}" data-file-name="a.pdf" data-mime-type="application/pdf" data-file-size="10">a.pdf</span></p>`;

describe('file chip blob lifecycle', () => {
  it('finds the blob of a chip that stores the blob:// URI form', () => {
    expect(deriveBlobReferences(docWithProse(chip(`blob://${HASH}`)))).toEqual([HASH]);
  });

  it('does NOT find a chip that stored a bare hash — the failure this design avoids', () => {
    // Pinned deliberately: if someone "simplifies" the attribute to a bare hash,
    // this test is what tells them the blob just became invisible to GC rather
    // than letting them find out from a support report.
    expect(deriveBlobReferences(docWithProse(chip(HASH)))).toEqual([]);
  });

  it('releases the blob when the chip is removed', () => {
    const before = deriveBlobReferences(docWithProse(chip(`blob://${HASH}`)));
    const after = deriveBlobReferences(docWithProse('<p>See </p>'));
    expect(before).toEqual([HASH]);
    // Derived from live content, so a removed chip genuinely drops the
    // reference — a union with the stored array could never shrink.
    expect(after).toEqual([]);
  });
});
