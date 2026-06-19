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
