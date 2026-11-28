/**
 * Delete with Undo for pages (DSK-260).
 *
 * Deleting a page from its tab used to be immediate, with no confirmation and
 * no way back. Now the page leaves every list at once, a toast offers Undo for
 * ten seconds, and the page is deleted for real only when that toast ends.
 * Undo simply cancels.
 *
 * Nothing changes in the document, local or shared, until the delete is real.
 * A shared delete removes only the page's list entry, so restoring one would
 * depend on content the Y.Doc happens to keep and on the orphan repair; a
 * delete that hasn't happened needs no restoring. Collaborators see the page
 * until then. If the window closes inside the ten seconds the page is kept:
 * losing a deletion is safer than losing a page.
 *
 * The real delete also runs early, before anything reads the whole document:
 * an export, or another document replacing this one.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import { onBeforeDocumentSwitch } from './autoSaveGuard';
import { useNotificationStore } from './notificationStore';
import { usePageStore } from './pageStore';
import { useRichTextPagesStore } from './richTextPagesStore';

/** A writing page (prose) or a diagram (canvas). */
export type PageDeleteKind = 'prose' | 'canvas';

/** How long Undo is offered. The toast's countdown pauses under the pointer. */
export const PAGE_UNDO_WINDOW_MS = 10_000;

interface PendingPageDelete {
  kind: PageDeleteKind;
  toastId: string;
  /** The page was the one shown; Undo shows it again. */
  wasActive: boolean;
}

interface PendingPageDeleteState {
  pending: Record<string, PendingPageDelete>;
}

export const usePendingPageDeletes = create<PendingPageDeleteState>(() => ({ pending: {} }));

interface PageListAccess {
  order: string[];
  activeId: string | null;
  exists: (id: string) => boolean;
  open: (id: string) => void;
  remove: (id: string) => void;
}

function pageList(kind: PageDeleteKind): PageListAccess {
  if (kind === 'prose') {
    const s = useRichTextPagesStore.getState();
    return {
      order: s.pageOrder,
      activeId: s.activePageId,
      exists: (id) => id in s.pages,
      open: s.setActivePage,
      remove: s.deletePage,
    };
  }
  const s = usePageStore.getState();
  return {
    order: s.pageOrder,
    activeId: s.activePageId,
    exists: (id) => id in s.pages,
    open: s.setActivePage,
    remove: s.deletePage,
  };
}

/** The pages of a kind still on show: the order without those waiting to be deleted. */
export function visiblePageIds(kind: PageDeleteKind): string[] {
  const { pending } = usePendingPageDeletes.getState();
  return pageList(kind).order.filter((id) => !(id in pending));
}

/** Whether a page can be deleted now: it's on show and isn't the last of its kind. */
export function canDeletePage(kind: PageDeleteKind, id: string): boolean {
  const visible = visiblePageIds(kind);
  return visible.length > 1 && visible.includes(id);
}

/** Whether a page is waiting out its Undo. */
export function isPageDeletePending(id: string): boolean {
  return id in usePendingPageDeletes.getState().pending;
}

function take(id: string): PendingPageDelete | undefined {
  const entry = usePendingPageDeletes.getState().pending[id];
  if (!entry) return undefined;
  usePendingPageDeletes.setState((s) => {
    const rest = { ...s.pending };
    delete rest[id];
    return { pending: rest };
  });
  return entry;
}

function commit(id: string): void {
  const entry = take(id);
  if (!entry) return;
  const list = pageList(entry.kind);
  if (list.exists(id)) list.remove(id);
}

/** Commit when the toast leaves: its countdown ended, it was closed, or newer toasts pushed it out. */
function commitWhenToastEnds(id: string, toastId: string): void {
  const unsubscribe = useNotificationStore.subscribe((state) => {
    if (state.notifications.some((n) => n.id === toastId)) return;
    unsubscribe();
    if (usePendingPageDeletes.getState().pending[id]?.toastId === toastId) commit(id);
  });
}

/**
 * Delete a page with Undo. Returns false, changing nothing, for the last page
 * of its kind on show. `label` is the page's name as the user sees it.
 */
export function requestPageDelete(kind: PageDeleteKind, id: string, label: string): boolean {
  if (!canDeletePage(kind, id)) return false;
  const list = pageList(kind);
  const wasActive = list.activeId === id;
  if (wasActive) {
    // Show the next page in order (or the previous one) in its place.
    const visible = visiblePageIds(kind);
    const at = visible.indexOf(id);
    const neighbour = visible[at + 1] ?? visible[at - 1];
    if (neighbour) list.open(neighbour);
  }
  const toastId = useNotificationStore.getState().notify({
    message: `“${label}” deleted`,
    severity: 'info',
    actionLabel: 'Undo',
    onAction: () => undoPageDelete(id),
    duration: PAGE_UNDO_WINDOW_MS,
  });
  usePendingPageDeletes.setState((s) => ({ pending: { ...s.pending, [id]: { kind, toastId, wasActive } } }));
  commitWhenToastEnds(id, toastId);
  return true;
}

/** Undo a page deletion that hasn't happened yet: the page returns, and is shown again if it was. */
export function undoPageDelete(id: string): void {
  const entry = take(id);
  if (!entry) return;
  const list = pageList(entry.kind);
  if (entry.wasActive && list.exists(id)) list.open(id);
}

/** Delete every page waiting out its Undo now, and close their toasts. */
export function flushPendingPageDeletes(): void {
  for (const [id, entry] of Object.entries(usePendingPageDeletes.getState().pending)) {
    commit(id);
    useNotificationStore.getState().dismiss(entry.toastId);
  }
}

// A page deleted just before another document opens is deleted in its own.
onBeforeDocumentSwitch(flushPendingPageDeletes);

/** The ids of pages waiting to be deleted, for lists to leave out. */
export function usePendingDeleteIds(): ReadonlySet<string> {
  const pending = usePendingPageDeletes((s) => s.pending);
  return useMemo(() => new Set(Object.keys(pending)), [pending]);
}
