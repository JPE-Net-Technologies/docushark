import { usePageStore } from '../store/pageStore';
import { isRelaySessionLive, useCollaborationStore } from './collaborationStore';

/**
 * JP-341: canvas page-guard. The relay's authoritative Y.Doc holds only the
 * **active page's** shapes, bound to the page it hydrated on join (JP-34
 * active-page-only). A client can switch canvas pages locally without the relay
 * following, so a shape drawn on the switched-to page would flow into the relay's
 * surface and flatten onto the WRONG page (silent misplacement). Until per-page
 * shape surfaces land (JP-340), the off-relay page is made view-only.
 *
 * Scoped to ONLINE relay collab only (`relayLive`): purely-local and offline docs
 * persist the whole document (all pages) via `pageStore`, so they have no
 * relay-flatten contamination and must keep full multi-page editing.
 */

/** Pure decision: an online relay session bound to a DIFFERENT page than the one
 *  currently active → the active page can't be safely edited this session. */
export function canvasPageGuarded(args: {
  relayLive: boolean;
  relayPageId: string | null;
  activePageId: string | null;
}): boolean {
  const { relayLive, relayPageId, activePageId } = args;
  if (!relayLive || relayPageId === null) return false;
  return activePageId !== relayPageId;
}

/** Store-wired imperative form — read at mutation/sync time (engine + write-gate). */
export function isCanvasPageGuarded(): boolean {
  return canvasPageGuarded({
    relayLive: isRelaySessionLive(),
    relayPageId: useCollaborationStore.getState().relayPageId,
    activePageId: usePageStore.getState().activePageId,
  });
}
