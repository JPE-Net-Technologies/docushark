/**
 * JP-334: the page-switch effect saves "the page we are leaving" from the
 * currently-mounted editor. That's only correct when the editor is actually
 * bound to that page. When a read-only page is involved (an offline-created
 * page renders `ProsePreview`, no editor), the mounted `editor`,
 * `lastActivePageRef`, and `activePageId` fall out of lockstep, and the save
 * would write the *incoming* editable page's content into the *leaving*
 * (read-only) page's `richTextPages` slot — cross-page contamination.
 *
 * Guard the save on this: only persist when the editor's bound page id matches
 * the page being left.
 */
export function shouldPersistLeavingPage(
  editorPageId: string | null,
  leavingPageId: string | null,
): boolean {
  return editorPageId != null && editorPageId === leavingPageId;
}

/** What the editor panel knows when asked to copy its editor into the store. */
export interface MountedPageFlush {
  /** The page the mounted editor is bound to (null: a read-only preview, no editor). */
  editorPageId: string | null;
  /** The page the panel shows (its last loaded page). */
  shownPageId: string | null;
  /** The document the panel last loaded. */
  panelDocId: string | null;
  /** The open document, the one being saved (null until a new one's first save). */
  openDocId: string | null;
  /** A page load is in flight: the editor still holds the previous page. */
  loading: boolean;
  /** The editor accepts edits; a read-only one holds nothing unsaved. */
  editable: boolean;
  /** A workspace document: the collab editor mirrors every update itself. */
  relay: boolean;
}

/**
 * DSK-199: may the panel copy its mounted editor's content into the pages
 * store, as every save now asks it to? Only when that content is this
 * document's and this page's latest — never one document's prose into
 * another's same-id page slot (the panel's editor still holds the previous
 * document until its load effect runs; see DSK-192, JP-428), never mid-load,
 * never across pages (JP-334), and never from a read-only editor.
 */
export function shouldFlushMountedPage(s: MountedPageFlush): boolean {
  return (
    !s.relay &&
    !s.loading &&
    s.editable &&
    shouldPersistLeavingPage(s.editorPageId, s.shownPageId) &&
    s.panelDocId === s.openDocId
  );
}
