/**
 * Pending-sync pages (JP-335) — pages created locally while their relay-backed
 * doc was OFFLINE, not yet handed to the relay. Transient sync bookkeeping,
 * deliberately NOT a document-format field: it must never leak into the body
 * the relay stores, and it needs no migration chain (mirrors the
 * shapePickerStore isolation rationale). Persisted so an offline reload keeps
 * protecting the page.
 *
 * What the marker drives:
 *  - **Editability** (DocumentEditorPanel): an empty never-synced prose
 *    fragment is normally read-only (relay is the sole seeder, JP-284). A
 *    pending page is editable — its id is fresh, so its `prose:<id>` fragment
 *    exists nowhere else and cannot double on a later merge.
 *  - **Prune-spare** (applyRemote*PageList): reconnect page-list adoption must
 *    not delete a page the relay hasn't learned about yet.
 *  - **Body-withhold** (persistenceStore): REST bodies serialize a pending
 *    page's content as '' so a queued replay can never make the relay's
 *    JSON-hydration seeder mint a competing prose lineage (the JP-282 double).
 *
 * Cleared by the reconnect handoff (useCollaborationSync) once a live synced
 * exchange has carried the page's meta + content to the relay.
 *
 * Keyed by pageId alone: page ids are nanoids, globally unique across docs, so
 * consumers (store-level prune, body serialization) don't need doc context.
 * The docId value exists for doc-scoped enumeration by the handoff.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { DiagramDocument } from '../types/Document';

export interface PendingSyncPagesState {
  /** pageId → docId it was created in. */
  pending: Record<string, string>;
  /** Mark a page as created-offline, awaiting relay handoff. */
  markPending: (pageId: string, docId: string) => void;
  /** Clear one page's marker (handoff complete, or page deleted locally). */
  clearPending: (pageId: string) => void;
  /** Clear every marker for a doc (doc deleted / transferred). */
  clearDoc: (docId: string) => void;
}

export const usePendingSyncPages = create<PendingSyncPagesState>()(
  persist(
    (set) => ({
      pending: {},
      markPending: (pageId, docId) =>
        set((state) => ({ pending: { ...state.pending, [pageId]: docId } })),
      clearPending: (pageId) =>
        set((state) => {
          if (!(pageId in state.pending)) return state;
          const next = { ...state.pending };
          delete next[pageId];
          return { pending: next };
        }),
      clearDoc: (docId) =>
        set((state) => ({
          pending: Object.fromEntries(
            Object.entries(state.pending).filter(([, d]) => d !== docId),
          ),
        })),
    }),
    {
      name: 'docushark-pending-sync-pages',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ pending: state.pending }),
    },
  ),
);

/** Non-reactive: is this page awaiting relay handoff? */
export function isPagePendingSync(pageId: string): boolean {
  return pageId in usePendingSyncPages.getState().pending;
}

/** Non-reactive: all pending page ids belonging to `docId`. */
export function pendingPagesForDoc(docId: string): string[] {
  return Object.entries(usePendingSyncPages.getState().pending)
    .filter(([, d]) => d === docId)
    .map(([pageId]) => pageId);
}

/**
 * The body-withhold (JP-335): return `doc` with every pending-sync prose page's
 * `content` blanked, for REST-bound bodies (queue replay or live push). If a
 * pending page's HTML landed in the relay's stored JSON, the sole-seeder
 * hydration (`json_prose_to_ydoc`) would mint a deterministic prose lineage
 * that merge-DOUBLES against the client's live fragment (the JP-282 class);
 * empty content is skipped by that seeder, closing the hole. The page's meta
 * stays in the body (tab survives); canvas shapes need no withholding (id-keyed
 * map — merges by key, no dup). Returns the input unchanged when nothing is
 * pending. Local caches must keep the FULL body — apply this only at the REST
 * boundary.
 */
export function withholdPendingProseFromBody(doc: DiagramDocument): DiagramDocument {
  const rtp = doc.richTextPages;
  if (!rtp) return doc;
  const { pending } = usePendingSyncPages.getState();
  const withheld = Object.keys(rtp.pages).filter((id) => {
    const page = rtp.pages[id];
    return id in pending && page !== undefined && page.content !== '';
  });
  if (withheld.length === 0) return doc;
  const pages = { ...rtp.pages };
  for (const id of withheld) {
    const page = pages[id];
    if (page) pages[id] = { ...page, content: '' };
  }
  return { ...doc, richTextPages: { ...rtp, pages } };
}
