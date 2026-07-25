/**
 * Resume an interrupted device-code sign-in (JP-455).
 *
 * When the editor is torn down mid-flow the grant survives in
 * [[pendingSignIn]], but something has to pick the poll back up. Two callers
 * want that: app boot (so the authorize page's "it will finish signing in
 * automatically" promise holds across a restart) and the Cloud panel mounting
 * (so reopening the modal shows the live flow rather than a fresh form).
 *
 * **Single owner.** Both go through `ensureSignInResumed`, which is idempotent
 * and keeps exactly one poller for a given grant. If boot and the panel each
 * ran their own loop they would double-poll the same `device_code` and trip the
 * relay's `slow_down` backoff — making a flow that is *already* late even
 * slower. For the same reason the session-committing side effects
 * (`completeCloudSignIn`, clearing the grant) live here rather than in each
 * caller, so a token can never be redeemed twice.
 *
 * Callers observe `done` purely to drive UI; the session is stood up either way.
 */

import { resumeCloudSignIn, type CloudSignInResult } from './cloudAuth';
import { loadPendingSignIn, clearPendingSignIn, type PendingSignIn } from './pendingSignIn';
import { completeCloudSignIn } from './completeCloudSignIn';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { usePersistenceStore } from '../store/persistenceStore';

export interface ActiveResume {
  /** The grant being polled — the panel renders its code + verification link. */
  grant: PendingSignIn;
  /**
   * Settles once the flow terminates. Resolves with the result **after** the
   * session has been committed; rejects with the terminal `CloudAuthError`.
   */
  done: Promise<CloudSignInResult>;
  /** Stop polling. Does not clear the stored grant — a later mount may resume. */
  cancel(): void;
}

let active: ActiveResume | null = null;
/**
 * The *in-flight* start, memoised separately from the settled `active`.
 *
 * Checking `active` alone is not single-flight: it is set after an `await`, so
 * two concurrent callers (boot and the panel mounting on the same tick) both
 * see `null`, both proceed, and both spin up a poller for the same
 * `device_code` — double-polling into the relay's `slow_down` backoff and, on
 * success, redeeming the same grant twice.
 */
let starting: Promise<ActiveResume | null> | null = null;

/**
 * Start — or join — the resume of a stored grant. Returns `null` when there is
 * nothing to resume (no grant, an expired one, or we're already signed in).
 */
export function ensureSignInResumed(): Promise<ActiveResume | null> {
  if (active) return Promise.resolve(active);
  if (starting) return starting;
  starting = start().finally(() => {
    // Release the latch once settled: `active` now guards a live resume, and a
    // null outcome should be retryable rather than cached forever.
    starting = null;
  });
  return starting;
}

async function start(): Promise<ActiveResume | null> {
  const pending = await loadPendingSignIn();
  if (!pending) return null;

  // Already signed in — the grant is moot (e.g. a cached token was reused, or
  // another surface completed first). Drop it rather than poll a dead code.
  if (useRelayDocumentStore.getState().authenticated) {
    await clearPendingSignIn();
    return null;
  }

  const handle = resumeCloudSignIn(pending);

  const done = (async (): Promise<CloudSignInResult> => {
    try {
      const result = await handle.result;
      await completeCloudSignIn({
        relayUrl: result.relayUrl?.trim() || pending.relayUrl,
        cloudBaseUrl: pending.cloudBaseUrl,
        token: result.token,
        expiresAt: result.expiresAt,
        documentId: usePersistenceStore.getState().currentDocumentId,
        ...(result.workspaceName !== undefined ? { workspaceName: result.workspaceName } : {}),
        ...(result.workspaceSlug !== undefined ? { workspaceSlug: result.workspaceSlug } : {}),
      });
      await clearPendingSignIn();
      return result;
    } catch (err) {
      // Terminal: denied, expired, or a transport failure. The grant is spent
      // either way — keeping it would retry a code that cannot succeed.
      await clearPendingSignIn();
      throw err;
    } finally {
      active = null;
    }
  })();

  // The caller may not attach a handler (boot fires and forgets), and an
  // unobserved rejection would surface as an unhandled promise rejection.
  void done.catch(() => {});

  active = {
    grant: pending,
    done,
    cancel: () => {
      handle.cancel();
      active = null;
    },
  };
  return active;
}

/** The in-flight resume, if any — lets a mounting panel render the live flow. */
export function getActiveResume(): ActiveResume | null {
  return active;
}

/** Test-only: drop the module-level singleton between cases. */
export function __resetActiveResumeForTests(): void {
  active = null;
  starting = null;
}
