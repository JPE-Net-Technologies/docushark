/**
 * JP-475 — mirror-family derivation. Pure functions over (pages, pageOrder)
 * snapshots; the invariants here are what the tab bar, ingest service, and
 * Navigator all lean on: orphans are roots, cycles never loop a traversal,
 * and the physical block is the contiguous run only.
 */
import { describe, it, expect } from 'vitest';

import type { PageMirrorMeta } from '../types/PageMirror';
import {
  buildMirrorFamilyIndex,
  descendantEntries,
  familyBlock,
  isFamilyRoot,
  subtreeInsertionIndex,
  type MirrorFamilyPage,
} from './mirrorFamily';

function mirror(externalId: string, parentExternalId?: string, provider = 'notion'): PageMirrorMeta {
  return { provider, externalId, syncedAt: 1, ...(parentExternalId ? { parentExternalId } : {}) };
}

function doc(entries: [string, PageMirrorMeta | undefined][]): {
  pages: Record<string, MirrorFamilyPage>;
  pageOrder: string[];
} {
  const pages: Record<string, MirrorFamilyPage> = {};
  for (const [id, m] of entries) {
    pages[id] = m ? { id, mirror: m } : { id };
  }
  return { pages, pageOrder: entries.map(([id]) => id) };
}

describe('buildMirrorFamilyIndex (JP-475)', () => {
  it('derives parent/child edges within one provider, in pageOrder sequence', () => {
    const { pages, pageOrder } = doc([
      ['P', mirror('ext-p')],
      ['C1', mirror('ext-c1', 'ext-p')],
      ['C2', mirror('ext-c2', 'ext-p')],
      ['N', undefined],
    ]);
    const index = buildMirrorFamilyIndex(pages, pageOrder);
    expect(index.childrenOf.get('P')).toEqual(['C1', 'C2']);
    expect(index.parentOf.get('C1')).toBe('P');
    expect(isFamilyRoot(index, 'P')).toBe(true);
    expect(isFamilyRoot(index, 'C1')).toBe(false);
    expect(isFamilyRoot(index, 'N')).toBe(true);
  });

  it('a provider boundary breaks the chain (same externalId, different provider)', () => {
    const { pages, pageOrder } = doc([
      ['P', mirror('ext-p', undefined, 'confluence')],
      ['C', mirror('ext-c', 'ext-p', 'notion')],
    ]);
    const index = buildMirrorFamilyIndex(pages, pageOrder);
    expect(index.parentOf.has('C')).toBe(false);
    expect(isFamilyRoot(index, 'C')).toBe(true);
  });

  it('an orphan (parent absent) is a root', () => {
    const { pages, pageOrder } = doc([['C', mirror('ext-c', 'ext-gone')]]);
    const index = buildMirrorFamilyIndex(pages, pageOrder);
    expect(isFamilyRoot(index, 'C')).toBe(true);
  });

  it('breaks parentExternalId cycles instead of looping', () => {
    const { pages, pageOrder } = doc([
      ['A', mirror('ext-a', 'ext-b')],
      ['B', mirror('ext-b', 'ext-a')],
    ]);
    const index = buildMirrorFamilyIndex(pages, pageOrder);
    // One edge dropped — at least one of the two is a root, and traversal ends.
    const roots = ['A', 'B'].filter((id) => isFamilyRoot(index, id));
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(descendantEntries(index, 'A').length + descendantEntries(index, 'B').length).toBeLessThan(4);
  });
});

describe('descendantEntries / familyBlock / subtreeInsertionIndex (JP-475)', () => {
  const nested = doc([
    ['P', mirror('ext-p')],
    ['C1', mirror('ext-c1', 'ext-p')],
    ['G1', mirror('ext-g1', 'ext-c1')],
    ['C2', mirror('ext-c2', 'ext-p')],
    ['N', undefined],
  ]);
  const index = buildMirrorFamilyIndex(nested.pages, nested.pageOrder);

  it('flattens the logical tree depth-first with depths', () => {
    expect(descendantEntries(index, 'P')).toEqual([
      { pageId: 'C1', depth: 1 },
      { pageId: 'G1', depth: 2 },
      { pageId: 'C2', depth: 1 },
    ]);
  });

  it('familyBlock is the contiguous run; insertion lands after it', () => {
    expect(familyBlock(index, nested.pageOrder, 'P')).toEqual(['P', 'C1', 'G1', 'C2']);
    expect(subtreeInsertionIndex(index, nested.pageOrder, 'P')).toBe(4);
    expect(subtreeInsertionIndex(index, nested.pageOrder, 'C1')).toBe(3);
  });

  it('a scattered descendant ends the physical block but stays in the logical tree', () => {
    // User dragged C1's subtree apart: order is P, C2, N, C1, G1.
    const scattered = ['P', 'C2', 'N', 'C1', 'G1'];
    expect(familyBlock(index, scattered, 'P')).toEqual(['P', 'C2']);
    expect(descendantEntries(index, 'P').map((e) => e.pageId)).toEqual(['C1', 'G1', 'C2']);
    // New children of P insert after the contiguous block, not after strays.
    expect(subtreeInsertionIndex(index, scattered, 'P')).toBe(2);
  });
});
