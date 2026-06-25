/**
 * Cloud control-plane client (JP-370).
 *
 * The editor's HTTP client for the proprietary `docushark-web` workspace +
 * invite endpoints — the membership roster that feeds the document-share
 * picker, the shareable invite links, and (later, for the switcher) the list of
 * workspaces a user belongs to. Parallel to `relayClient` (which talks to the
 * relay); this talks to `docushark-web` and authenticates with the SAME relay
 * app token (the only credential the editor holds — there is no Supabase
 * session here). The web verifies that token against its own JWKS.
 *
 * Functional + injectable (mirrors `cloudAuth`) so tests can stub `fetch`,
 * the cloud origin, and the token without touching global state.
 */
import { useConnectionStore } from '../store/connectionStore';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from './relayConnection';
import { activeWorkspaceId } from '../store/activeWorkspace';

export type WorkspaceRole = 'owner' | 'member' | 'viewer';

export interface WorkspaceMember {
  userId: string;
  email: string | null;
  displayName: string;
  role: WorkspaceRole;
}

export interface WorkspaceInvite {
  id: string;
  /** Shareable accept link (`https://<app>/invite/<token>`). */
  url: string;
  role: WorkspaceRole;
  expiresAt: string;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string | null;
  region: string;
  role: WorkspaceRole;
}

/** A relay app token re-scoped to one workspace (the switcher's per-connection token). */
export interface WorkspaceToken {
  token: string;
  /** Token expiry in Unix **seconds** (relay `exp`), as the web returns it. */
  expiresAt: number;
  /** Relay pod base URL for this workspace's region. */
  relayUrl: string;
  workspaceName: string | null;
  workspaceSlug: string | null;
}

/** A failed control-plane call. `status` is the HTTP status (0 = network/no-auth). */
export class WebClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'WebClientError';
  }
}

export interface WebClientDeps {
  fetchImpl?: typeof fetch;
  /** Cloud origin override (defaults to the persisted connection's, then the build default). */
  baseUrl?: string;
  /** Token override (defaults to the live connection token). */
  token?: string | null;
}

async function resolveBase(deps: WebClientDeps): Promise<string> {
  if (deps.baseUrl) return deps.baseUrl.replace(/\/+$/, '');
  const conn = await loadConnection();
  return (conn?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
}

function resolveToken(deps: WebClientDeps): string | null {
  return deps.token !== undefined ? deps.token : useConnectionStore.getState().token;
}

async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  deps: WebClientDeps,
  body?: unknown,
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const token = resolveToken(deps);
  if (!token) throw new WebClientError(0, 'not_signed_in', 'Not signed in to the cloud');
  const base = await resolveBase(deps);

  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new WebClientError(0, 'network_error', e instanceof Error ? e.message : String(e));
  }

  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody?.error) code = errBody.error;
    } catch {
      /* non-JSON error body — keep the http_<status> code */
    }
    throw new WebClientError(res.status, code);
  }

  // 204 / empty bodies → undefined.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const webClient = {
  /** Roster of the workspace's members (feeds the share picker). */
  async getWorkspaceMembers(
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<WorkspaceMember[]> {
    const { members } = await request<{ members: WorkspaceMember[] }>(
      'GET',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/members`,
      deps,
    );
    return members ?? [];
  },

  /** The workspaces the caller belongs to (switcher source, PR-3c). */
  async listWorkspaces(deps: WebClientDeps = {}): Promise<WorkspaceSummary[]> {
    const { workspaces } = await request<{ workspaces: WorkspaceSummary[] }>(
      'GET',
      `/api/v1/workspaces`,
      deps,
    );
    return workspaces ?? [];
  },

  /** Mint a shareable invite link (owner-only). */
  async createInvite(
    role: 'member' | 'viewer',
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<WorkspaceInvite> {
    return request<WorkspaceInvite>(
      'POST',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/invites`,
      deps,
      { role },
    );
  },

  /** Active (pending) invites for the workspace (owner-only). */
  async listInvites(
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<WorkspaceInvite[]> {
    const { invites } = await request<{ invites: WorkspaceInvite[] }>(
      'GET',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/invites`,
      deps,
    );
    return invites ?? [];
  },

  /** Revoke a pending invite by its token (owner-only). */
  async revokeInvite(
    token: string,
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<void> {
    await request<void>(
      'DELETE',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(token)}`,
      deps,
    );
  },

  /**
   * Re-scope the relay token to a single workspace the caller belongs to
   * (JP-370 switcher). Returns a fresh token whose `wsp` is just that workspace,
   * plus its pod `relayUrl` + display identity. Authenticated with the current
   * relay token; the server re-checks membership against the DB.
   */
  async getWorkspaceToken(
    workspaceId: string,
    deps: WebClientDeps = {},
  ): Promise<WorkspaceToken> {
    const r = await request<{
      token: string;
      expires_at: number;
      relay_url: string;
      workspace_name?: string;
      workspace_slug?: string;
    }>('POST', `/api/v1/auth/workspace-token`, deps, { workspace_id: workspaceId });
    return {
      token: r.token,
      expiresAt: r.expires_at,
      relayUrl: r.relay_url,
      workspaceName: r.workspace_name ?? null,
      workspaceSlug: r.workspace_slug ?? null,
    };
  },

  /** Remove a member from the workspace (owner-only). */
  async removeMember(
    userId: string,
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<void> {
    await request<void>(
      'DELETE',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      deps,
    );
  },

  /**
   * Leave a workspace (self-removal). Any non-owner member may call this for
   * themselves; the owner is rejected server-side (they'd orphan the workspace).
   * The caller drops off the roster immediately and loses access on reconnect.
   */
  async leaveWorkspace(
    workspaceId: string = activeWorkspaceId(),
    deps: WebClientDeps = {},
  ): Promise<void> {
    await request<void>(
      'POST',
      `/api/v1/workspace/${encodeURIComponent(workspaceId)}/leave`,
      deps,
    );
  },
};
