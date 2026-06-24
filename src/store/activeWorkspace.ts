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
 * The workspace id the editor is currently authenticated to, for cache keying.
 * Resolved from the live relay token's first `wsp` claim; falls back to
 * `DEFAULT_WORKSPACE_ID`.
 */
export function activeWorkspaceId(): string {
  return workspaceIdFromRelayToken(useConnectionStore.getState().token) ?? DEFAULT_WORKSPACE_ID;
}
