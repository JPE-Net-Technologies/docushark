/**
 * Auto-refresh the team document list when the app regains focus or comes back
 * online (JP-324 #10).
 *
 * While a relay WS session is live the list already refreshes on its own: the
 * relay re-authenticates on every reconnect → `setAuthenticated(true)` →
 * `fetchDocumentList()`. The gap this closes is the *idle* case — the user is
 * signed in but sitting on a local/offline document, so there's no live WS and
 * no reconnect event. A document transferred from another session (e.g. their
 * first cloud doc, promoted elsewhere) would otherwise stay invisible until a
 * manual reload.
 *
 * `refreshDocumentList` is guarded (no-ops unless authenticated with a live
 * provider), so these listeners are cheap when signed out. A short throttle
 * collapses the focus + visibilitychange double-fire on a single tab return.
 *
 * Scope note (multi-workspace): this drives the single active relay's list via
 * the store's current provider. When connection management grows to multiple
 * workspaces, the refresh action — not this listener wiring — becomes the place
 * to fan out per `relayId`.
 */
import { useRelayDocumentStore } from '../store/relayDocumentStore';

let registered = false;

/** Minimum gap between auto-refreshes, to collapse focus + visibility double-fires. */
const MIN_INTERVAL_MS = 2_000;

/**
 * Register window/document listeners that refresh the relay document list on
 * regained focus / visibility / connectivity. Idempotent — a second call while
 * already registered is a no-op. Returns a disposer that removes the listeners.
 */
export function registerRelayListAutoRefresh(now: () => number = Date.now): () => void {
  if (registered || typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  registered = true;

  // Start in the distant past so the first refresh always passes the throttle,
  // regardless of the clock's origin.
  let lastRefresh = Number.NEGATIVE_INFINITY;
  const refresh = (): void => {
    const t = now();
    if (t - lastRefresh < MIN_INTERVAL_MS) return;
    lastRefresh = t;
    useRelayDocumentStore.getState().refreshDocumentList();
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') refresh();
  };

  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    registered = false;
  };
}

/** Test-only: re-arm registration after a disposer wasn't called. */
export function __resetRelayListAutoRefreshForTests(): void {
  registered = false;
}
