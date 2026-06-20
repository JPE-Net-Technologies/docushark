/**
 * Network-status watcher (JP-237).
 *
 * The browser's `online`/`offline` events are the fastest signal that the device
 * lost (or regained) network — far quicker than waiting for a silently-dropped
 * WebSocket to fire `onclose` (30–120s of TCP timeout). On `offline` we proactively
 * drop the live relay socket so the offline UI (status-bar chip / toast) appears
 * immediately and reconnect begins; on `online` we retry at once instead of waiting
 * on the backoff schedule.
 *
 * This is the fast-path for the common "wifi went off" case; the WS heartbeat
 * (UnifiedSyncProvider) covers drops the OS doesn't report (relay process died with
 * the network still up).
 */
import { useCollaborationStore } from '../collaboration/collaborationStore';

let registered = false;

/**
 * Register `online`/`offline` listeners that drive the relay connection. Idempotent;
 * returns a disposer that removes them.
 */
export function registerNetworkStatusWatcher(): () => void {
  if (registered || typeof window === 'undefined') return () => {};
  registered = true;

  const onOffline = (): void => useCollaborationStore.getState().handleNetworkOffline();
  const onOnline = (): void => useCollaborationStore.getState().handleNetworkOnline();

  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);

  return () => {
    window.removeEventListener('offline', onOffline);
    window.removeEventListener('online', onOnline);
    registered = false;
  };
}

/** Test-only: re-arm registration after a disposer wasn't called. */
export function __resetNetworkStatusWatcherForTests(): void {
  registered = false;
}
