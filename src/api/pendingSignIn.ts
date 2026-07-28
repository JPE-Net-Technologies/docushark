/**
 * Durable record of an **in-flight** device-code sign-in (JP-455).
 *
 * The OAuth device grant is a two-party affair: the user authorizes in a
 * browser while the editor polls for the token. Before this module the grant
 * existed only in a closure inside `cloudAuth.pollForToken` plus `phase` state
 * in `CloudConnectPanel`, whose unmount cleanup cancels the poll — so anything
 * that tore the page down mid-flow (an evicted backgrounded PWA, a same-tab
 * navigation) stranded a device the server had **already authorized**, and the
 * user came back to a pristine sign-in form.
 *
 * The web authorize page promises "Return to DocuShark — it will finish
 * signing in automatically." Persisting the grant is what lets the editor keep
 * that promise.
 *
 * **Why `secureStore` and not localStorage:** `deviceCode` is a bearer
 * credential — whoever holds it can exchange it for a relay token once the user
 * authorizes. It therefore lives in the same store as the relay JWT
 * (`platform/secureStore` → IndexedDB, localStorage only as a fallback), is
 * bounded by the grant's own short `expiresAt`, and is cleared the moment the
 * flow reaches any terminal state.
 *
 * Kept as its own key rather than as fields on the `RelayConnection` record:
 * the lifetimes are unrelated (this one is minutes and self-expiring, that one
 * is the durable session) and conflating them would mean a token save could
 * resurrect or clobber a grant.
 */

import { secureStore } from '../platform/secureStore';

const STORAGE_KEY = 'docushark-pending-signin';

/** An issued-but-not-yet-redeemed device grant. */
export interface PendingSignIn {
  /** RFC 8628 `device_code` — the credential polled with. Bearer; see module doc. */
  deviceCode: string;
  /** Human-typed code, shown so a resumed flow displays the same one. */
  userCode: string;
  /** Verification page URL with the code pre-filled. */
  verificationUri: string;
  /** Poll interval in ms (already max'd against the RFC minimum). */
  intervalMs: number;
  /** Absolute expiry (Unix ms). Stored absolute so it survives a restart. */
  expiresAt: number;
  /** docushark-web origin the grant was issued by. */
  cloudBaseUrl: string;
  /** Relay origin the resulting session should target. */
  relayUrl: string;
}

/** Persist the grant. Best-effort: a storage failure must not break sign-in. */
export async function savePendingSignIn(pending: PendingSignIn): Promise<void> {
  try {
    await secureStore.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    /* storage-disabled context — the flow still works in-memory */
  }
}

/**
 * Read the stored grant, or `null` when there is none, it is malformed, or it
 * has expired. An expired/malformed record is cleared as a side effect so a
 * dead grant can never accumulate or be retried.
 *
 * `now` is injectable for tests.
 */
export async function loadPendingSignIn(
  now: () => number = Date.now,
): Promise<PendingSignIn | null> {
  let raw: string | null = null;
  try {
    raw = await secureStore.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    void clearPendingSignIn();
    return null;
  }

  if (!isPendingSignIn(parsed)) {
    void clearPendingSignIn();
    return null;
  }
  if (now() >= parsed.expiresAt) {
    void clearPendingSignIn();
    return null;
  }
  return parsed;
}

/** Drop the stored grant. Call on every terminal outcome. */
export async function clearPendingSignIn(): Promise<void> {
  try {
    await secureStore.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Structural guard. A record written by an older build (or corrupted) must be
 * rejected rather than half-used — a grant missing `deviceCode` or `expiresAt`
 * would otherwise drive an unbounded poll against a code that cannot succeed.
 */
function isPendingSignIn(value: unknown): value is PendingSignIn {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['deviceCode'] === 'string' &&
    v['deviceCode'].length > 0 &&
    typeof v['userCode'] === 'string' &&
    typeof v['verificationUri'] === 'string' &&
    typeof v['intervalMs'] === 'number' &&
    Number.isFinite(v['intervalMs']) &&
    typeof v['expiresAt'] === 'number' &&
    Number.isFinite(v['expiresAt']) &&
    typeof v['cloudBaseUrl'] === 'string' &&
    typeof v['relayUrl'] === 'string'
  );
}
