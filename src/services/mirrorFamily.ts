/**
 * Mirror families (JP-475) — pure derivation of the LOGICAL subpage tree from
 * `PageMirrorMeta.parentExternalId`, decoupled from the PHYSICAL page sequence.
 *
 * The two axes never merge: `pageOrder` stays a flat array (it is the export
 * order); a family is derived by chaining `parentExternalId` → `externalId`
 * among the document's mirror pages of the same provider. An orphan (parent
 * page deleted or detached) is a root. Ingestion inserts contiguously, but the
 * user may scatter a family by dragging — a family's physical *block* is the
 * contiguous descendant run starting at the root, while the logical tree
 * (flyout, Navigator) renders complete regardless of scatter.
 *
 * Everything here is pure over `(pages, pageOrder)` snapshots — no store
 * imports, no React — so it unit-tests directly and both the tab bar and the
 * Navigator consume one implementation.
 */

import type { PageMirrorMeta } from '../types/PageMirror';

/** The minimal page shape the derivation needs (RichTextPage satisfies it). */
export interface MirrorFamilyPage {
  id: string;
  mirror?: PageMirrorMeta;
}

export interface MirrorFamilyIndex {
  /** `(provider, externalId)` → owning pageId, for mirror pages in the doc. */
  byExternal: Map<string, string>;
  /** parent pageId → child pageIds, in `pageOrder` sequence. */
  childrenOf: Map<string, string[]>;
  /** child pageId → parent pageId (only when the parent page is in the doc,
   *  and the edge is not part of a cycle). */
  parentOf: Map<string, string>;
}

export function externalKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/**
 * Build the family index for one page-list snapshot. Cycle-defensive: an edge
 * that would close a `parentExternalId` loop is dropped (its child renders as
 * a root) rather than ever looping a traversal.
 */
export function buildMirrorFamilyIndex(
  pages: Record<string, MirrorFamilyPage>,
  pageOrder: string[],
): MirrorFamilyIndex {
  const byExternal = new Map<string, string>();
  for (const id of pageOrder) {
    const m = pages[id]?.mirror;
    if (m) byExternal.set(externalKey(m.provider, m.externalId), id);
  }

  const parentOf = new Map<string, string>();
  for (const id of pageOrder) {
    const m = pages[id]?.mirror;
    if (!m?.parentExternalId) continue;
    const parentId = byExternal.get(externalKey(m.provider, m.parentExternalId));
    if (parentId !== undefined && parentId !== id) parentOf.set(id, parentId);
  }

  // Break cycles: walk each page toward the root; any edge that revisits a
  // node in the current walk is removed (deterministic — earlier pages win).
  for (const start of pageOrder) {
    const seen = new Set<string>([start]);
    let cur = start;
    for (;;) {
      const parent = parentOf.get(cur);
      if (parent === undefined) break;
      if (seen.has(parent)) {
        parentOf.delete(cur);
        break;
      }
      seen.add(parent);
      cur = parent;
    }
  }

  const childrenOf = new Map<string, string[]>();
  for (const id of pageOrder) {
    const parent = parentOf.get(id);
    if (parent === undefined) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(id);
    else childrenOf.set(parent, [id]);
  }

  return { byExternal, childrenOf, parentOf };
}

/** True when the page has no in-doc parent (top-level in every surface). */
export function isFamilyRoot(index: MirrorFamilyIndex, pageId: string): boolean {
  return !index.parentOf.has(pageId);
}

/** One node of the logical tree, depth relative to the requested root. */
export interface FamilyTreeEntry {
  pageId: string;
  depth: number;
}

/**
 * Depth-first flatten of a page's LOGICAL descendants (excluding the page
 * itself), children in `pageOrder` sequence. Complete regardless of physical
 * scatter.
 */
export function descendantEntries(index: MirrorFamilyIndex, pageId: string, depth = 1): FamilyTreeEntry[] {
  const out: FamilyTreeEntry[] = [];
  for (const child of index.childrenOf.get(pageId) ?? []) {
    out.push({ pageId: child, depth });
    out.push(...descendantEntries(index, child, depth + 1));
  }
  return out;
}

/**
 * The PHYSICAL block a root drags as one unit: the root plus the contiguous
 * run of its descendants directly following it in `pageOrder`. Descendants the
 * user moved elsewhere stay where the user put them.
 */
export function familyBlock(index: MirrorFamilyIndex, pageOrder: string[], rootId: string): string[] {
  const start = pageOrder.indexOf(rootId);
  if (start === -1) return [];
  const descendants = new Set(descendantEntries(index, rootId).map((e) => e.pageId));
  const block = [rootId];
  for (let i = start + 1; i < pageOrder.length; i++) {
    const id = pageOrder[i];
    if (id === undefined || !descendants.has(id)) break;
    block.push(id);
  }
  return block;
}

/**
 * Where ingestion inserts a new child of `parentId`: directly after the
 * parent's contiguous block, so out of the box the physical order reads
 * depth-first. Falls back to appending when the parent left the order.
 */
export function subtreeInsertionIndex(
  index: MirrorFamilyIndex,
  pageOrder: string[],
  parentId: string,
): number {
  const start = pageOrder.indexOf(parentId);
  if (start === -1) return pageOrder.length;
  return start + familyBlock(index, pageOrder, parentId).length;
}
