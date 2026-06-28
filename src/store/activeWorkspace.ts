/**
 * Active workspace id for cloud-document cache scoping (JP-370).
 *
 * The editor's cloud-doc caches (RelayDocumentCache, documentRegistry,
 * TrashStorage) must be partitioned by workspace, because multiple workspaces
 * can be served by the SAME relay origin (all in one region at launch) — so a
 * relay-host key alone would let two workspaces' documents collide. The
 * workspace id (globally unique) is the correct scope key; the relay host id
 * (JP-117) stays only for save-routing.
 */
import { useConnectionStore } from './connectionStore';
import { workspaceIdFromRelayToken } from '../api/relayTokenUser';

/**
 * Cache scope used when no workspace claim is present (legacy/self-host
 * single-tenant token, or signed-out). Mirrors `WorkspaceId::single_tenant()`
 * on the relay so a self-hosted single-tenant relay keeps one coherent cache.
 */
export const DEFAULT_WORKSPACE_ID = 'default';

/**
 * localStorage key for the last real workspace id we authenticated to. This is
 * the durable fallback scope (JP-390): the in-memory relay token is gone on
 * every cold boot, and an EXPIRED token is never re-asserted into the store, so
 * without a remembered scope `activeWorkspaceId()` would collapse to
 * `DEFAULT_WORKSPACE_ID` — and the registry's workspace-scope filter would hide
 * every cached relay doc that was stamped with the real workspace id (the doc
 * still opens directly, but vanishes from the list).
 */
const LAST_WORKSPACE_KEY = 'docushark-last-workspace-id';

/**
 * Remember the last real workspace id so cloud-doc scoping survives token loss
 * (JP-390). No-op for the single-tenant default / absent id. Called from the
 * token choke point (`connectionStore.setToken`) and the expired-boot recovery
 * (`restoreCloudSession`), so every real session records its workspace.
 */
export function rememberWorkspaceId(id: string | null | undefined): void {
  if (!id || id === DEFAULT_WORKSPACE_ID) return;
  try {
    if (localStorage.getItem(LAST_WORKSPACE_KEY) !== id) {
      localStorage.setItem(LAST_WORKSPACE_KEY, id);
    }
  } catch {
    // localStorage unavailable (private mode / SSR) — fallback just degrades to
    // DEFAULT_WORKSPACE_ID, never throws into an auth flow.
  }
}

/**
 * Forget the remembered workspace id. Called on a full workspace removal so we
 * don't restore into a workspace whose caches were just purged.
 */
export function clearRememberedWorkspaceId(): void {
  try {
    localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    // ignore — see rememberWorkspaceId
  }
}

/**
 * The workspace id the editor is currently scoped to, for cache keying.
 * Resolved from the live relay token's first `wsp` claim; on a cold/expired
 * boot (no in-memory token) falls back to the last real workspace we saw
 * (JP-390), then to `DEFAULT_WORKSPACE_ID`.
 */
export function activeWorkspaceId(): string {
  const live = workspaceIdFromRelayToken(useConnectionStore.getState().token);
  if (live) return live;
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY) ?? DEFAULT_WORKSPACE_ID;
  } catch {
    return DEFAULT_WORKSPACE_ID;
  }
}
