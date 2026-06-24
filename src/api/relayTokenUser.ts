/**
 * Derive the editor's authenticated user from a relay app token (JWT).
 *
 * A REST-only Cloud sign-in (cached session, no WebSocket) never receives the
 * relay's `MESSAGE_AUTH_RESPONSE`, which is the only place the live path sets
 * `connectionStore.user`. Without a user, surfaces that gate on identity (e.g.
 * the document-browser transfer, which bails on `!currentUser?.id`) silently
 * no-op. We recover the same identity by decoding the token's payload.
 *
 * The relay JWT (see `relay/src/auth/jwt.rs`) carries `sub` (the user id) and
 * `wsp[].role`, but NO username — the relay itself surfaces `sub` as the
 * username for OIDC tokens (server/mod.rs), so we mirror that. The signature is
 * NOT verified here: this is display/gating identity only; the relay verifies
 * the token on every REST/WS request.
 */
import type { AuthenticatedUser } from '../store/connectionStore';

/**
 * Decode a JWT payload (the middle, base64url segment) without verifying the
 * signature. Pure; returns `null` on any malformed input — auth flows must
 * never throw on a bad token.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  const seg = parts[1];
  if (parts.length < 2 || !seg) return null;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const bytes = atob(padded);
    // UTF-8 safe decode (claims may carry non-ASCII).
    const json = decodeURIComponent(
      bytes
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Build an `AuthenticatedUser` from a relay app token, or `null` if the token
 * has no usable subject. `username` mirrors the relay's OIDC behavior (= `sub`);
 * `role` comes from the first workspace claim when present.
 */
export function userFromRelayToken(token: string): AuthenticatedUser | null {
  const claims = decodeJwtPayload(token);
  const sub = claims?.['sub'];
  if (typeof sub !== 'string' || sub.length === 0) return null;

  let role: string | undefined;
  const wsp = claims?.['wsp'];
  if (Array.isArray(wsp) && wsp.length > 0) {
    const first = wsp[0] as Record<string, unknown> | undefined;
    if (first && typeof first['role'] === 'string') role = first['role'];
  }

  return { id: sub, username: sub, ...(role !== undefined ? { role } : {}) };
}

/**
 * The active workspace id from a relay app token's first `wsp` claim (JP-370).
 * This is the scope key the editor's cloud-document caches partition by, so two
 * workspaces served by the same relay origin never collide. Returns `null` when
 * the token is absent/malformed or carries no `wsp` entry (a legacy/self-host
 * single-tenant token); callers fall back to the relay's `"default"` workspace
 * id, mirroring `WorkspaceId::single_tenant()` on the relay.
 */
export function workspaceIdFromRelayToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const claims = decodeJwtPayload(token);
  const wsp = claims?.['wsp'];
  if (Array.isArray(wsp) && wsp.length > 0) {
    const first = wsp[0] as Record<string, unknown> | undefined;
    if (first && typeof first['id'] === 'string' && first['id'].length > 0) {
      return first['id'];
    }
  }
  return null;
}
