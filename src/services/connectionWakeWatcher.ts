/**
 * Wake-from-background watcher (JP-420).
 *
 * A backgrounded PWA is a blind spot the other watchers don't cover: the
 * browser throttles timers (reconnect retries fire on a schedule the user
 * never sees), the socket can die without an `onclose`, and the short-lived
 * relay token can cross its expiry — all WITHOUT a network `online`/`offline`
 * event, so `networkStatusWatcher` never fires. Before this, a returning user
 * could face a stuck "reconnecting" state that only a dismiss + re-sign-in +
 * document switch would clear.
 *
 * On tab-visible / window-focus this hands off to
 * `collaborationStore.handleAppWake()`, which refreshes a near-expiry token,
 * revives a stalled reconnect (toast-muted so a fast recovery is silent), or
 * heartbeat-probes a possibly-zombie socket. A short throttle collapses the
 * focus + visibilitychange double-fire on a single tab return.
 */
import { useCollaborationStore } from '../collaboration/collaborationStore';

let registered = false;

/** Minimum gap between wake handoffs, to collapse focus + visibility double-fires. */
const MIN_INTERVAL_MS = 2_000;

/**
 * Register visibility/focus listeners that drive connection wake recovery.
 * Idempotent — a second call while already registered is a no-op. Returns a
 * disposer that removes the listeners.
 */
export function registerConnectionWakeWatcher(now: () => number = Date.now): () => void {
  if (registered || typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  registered = true;

  // Start in the distant past so the first wake always passes the throttle.
  let lastWake = Number.NEGATIVE_INFINITY;
  const wake = (): void => {
    const t = now();
    if (t - lastWake < MIN_INTERVAL_MS) return;
    lastWake = t;
    useCollaborationStore.getState().handleAppWake();
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') wake();
  };

  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    window.removeEventListener('focus', wake);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    registered = false;
  };
}

/** Test-only: re-arm registration after a disposer wasn't called. */
export function __resetConnectionWakeWatcherForTests(): void {
  registered = false;
}
