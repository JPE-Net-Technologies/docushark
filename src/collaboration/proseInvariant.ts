/**
 * Fragment↔page-list invariant (JP-423).
 *
 * Prose content and prose page-list metadata live in DIFFERENT Y.Doc
 * surfaces with different write paths: the `prose:<id>` fragment syncs
 * unconditionally (y-prosemirror writes the shared doc), the `prosePages`
 * meta is a separate, forgettable write. When they diverge the page's
 * content exists but no list shows it — an orphaned fragment.
 *
 * Policy (deliberately conservative):
 *  - LOG every orphan, always — the observability floor.
 *  - REPAIR (synthesize the missing meta) only when corroborated by the
 *    local `richTextPagesStore` — i.e. THIS client believes the page exists.
 *    Adoption reconciles the store from the authoritative CRDT list before
 *    this runs, pruning legitimately deleted pages (pending-sync pages are
 *    prune-spared), so:
 *      - a deleted page's lingering root (Yjs roots are undeletable) has no
 *        store entry → log-only, never resurrected;
 *      - a writer mid-flight between fragment and meta (an integration
 *        writing non-atomically) has no store entry on OTHER clients →
 *        log-only, nothing fights the in-flight write.
 *  - Repair is ADDITIVE-only: the single op is `setProsePage`; fragments and
 *    metas are never deleted here. A wrong repair can at worst re-list a
 *    tab; it can never destroy content.
 */

import type { YjsDocument, ProsePageMeta } from './YjsDocument';
import { useRichTextPagesStore, type RichTextPage } from '../store/richTextPagesStore';

/**
 * The single construction point for a ProsePageMeta synthesized from local
 * page state (the reconnect handoff and the orphan repair both build through
 * here) — a future meta field lands in one place, not N call sites.
 */
export function synthesizeProsePageMeta(page: RichTextPage, order: number): ProsePageMeta {
  const meta: ProsePageMeta = {
    id: page.id,
    name: page.name,
    order: Math.max(0, order),
    createdAt: page.createdAt,
    modifiedAt: page.modifiedAt,
  };
  if (page.color !== undefined) meta.color = page.color;
  if (page.mirror !== undefined) meta.mirror = page.mirror;
  return meta;
}

export interface OrphanHealResult {
  /** Every orphaned fragment id found (logged). */
  logged: string[];
  /** The subset repaired by synthesizing a `prosePages` meta. */
  repaired: string[];
}

/**
 * Detect orphaned prose fragments and repair the corroborated ones. Runs at
 * adopt time, AFTER the page-list adoption reconciled `richTextPagesStore`
 * with the CRDT list. The `setProsePage` repair is a local→remote CRDT write —
 * call OUTSIDE any remote-apply window, like the reconnect handoff.
 */
export function healOrphanedProseFragments(yjsDoc: YjsDocument, docId: string): OrphanHealResult {
  const result: OrphanHealResult = { logged: [], repaired: [] };
  const orphans = yjsDoc.listOrphanedProseFragmentIds();
  if (orphans.length === 0) return result;

  const proseState = useRichTextPagesStore.getState();
  for (const pageId of orphans) {
    result.logged.push(pageId);
    const page = proseState.pages[pageId];
    if (page) {
      console.warn(
        `[proseInvariant] Orphaned prose fragment ${pageId} in ${docId} — ` +
          'content with no page-list meta; repairing from the local page (JP-423).',
      );
      yjsDoc.setProsePage(synthesizeProsePageMeta(page, proseState.pageOrder.indexOf(pageId)));
      result.repaired.push(pageId);
    } else {
      console.warn(
        `[proseInvariant] Orphaned prose fragment ${pageId} in ${docId} — ` +
          'no local corroboration (deleted page or an in-flight external write); left as-is (JP-423).',
      );
    }
  }
  return result;
}
