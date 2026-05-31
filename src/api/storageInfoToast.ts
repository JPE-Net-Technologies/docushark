/**
 * One-time "how storage works" toast, shown after a Cloud workspace connect.
 *
 * The PWA is public and un-gated — a first-time user can land via the web
 * one-click handoff and be editing in seconds. The first time they connect to a
 * workspace we surface a single, dismissable explainer of the storage model so
 * the metering isn't a surprise later. Persisted via `uiPreferencesStore` so it
 * fires at most once per browser.
 *
 * Lives in the api layer (not a React component) and only touches plain Zustand
 * store singletons — the same pattern as `notifyError` in `notificationStore`.
 */

import { useNotificationStore } from '../store/notificationStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

const STORAGE_INFO_MESSAGE =
  'Connected to your workspace. Cloud storage is metered by total size — ' +
  'viewers are always free, and documents you keep on this device stay free and offline.';

/** Show the storage explainer once, then remember it was shown. */
export function showStorageInfoToastOnce(): void {
  const prefs = useUIPreferencesStore.getState();
  if (prefs.storageInfoToastSeen) return;
  prefs.markStorageInfoToastSeen();
  useNotificationStore.getState().info(STORAGE_INFO_MESSAGE, { duration: 10000 });
}
