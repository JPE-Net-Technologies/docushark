/**
 * Service-worker registration for the PWA build.
 *
 * Web-only by construction: in the Tauri build `vite-plugin-pwa` is disabled
 * (see vite.config.ts), so `virtual:pwa-register`'s `registerSW` is a no-op
 * stub and this function does nothing — desktop uses the Tauri updater.
 *
 * Update strategy is 'prompt' (not skipWaiting): when a new service worker is
 * waiting we surface a soft, manual "Reload" notification so a live
 * collaboration session is never reloaded out from under the user.
 */

import { registerSW } from 'virtual:pwa-register';
import { useNotificationStore } from '../store/notificationStore';

/** Loop guard key — the timestamp of the last stale-chunk auto-reload. */
const STALE_CHUNK_KEY = 'ds:stale-chunk-reload';

/**
 * Recover an open tab after a deploy. When a lazy chunk's hashed file was
 * replaced by a newer build, the old URL 404s — and on a SPA host that 404
 * comes back as the `index.html` shell, so the dynamic import fails with
 * "Failed to load module script … text/html". Vite emits `vite:preloadError`
 * for exactly this; the old chunk is gone, so the only fix is to reload to the
 * current build. Guarded so a genuinely-missing chunk can't loop (reload at
 * most once per ~10s). Collab-safe: it only fires once an import has already
 * failed (the tab is broken anyway), never mid-edit on a healthy page — which
 * is why this complements, rather than replaces, the soft 'prompt' update flow.
 */
function installStaleChunkReload(): void {
  window.addEventListener('vite:preloadError', () => {
    const last = Number(sessionStorage.getItem(STALE_CHUNK_KEY) ?? '0');
    if (Date.now() - last < 10_000) return; // already reloaded recently — don't loop
    sessionStorage.setItem(STALE_CHUNK_KEY, String(Date.now()));
    window.location.reload();
  });
}

export function registerPwa(): void {
  installStaleChunkReload();

  const updateSW = registerSW({
    onNeedRefresh() {
      useNotificationStore.getState().info('A new version of DocuShark is available.', {
        category: 'permanent',
        duration: 0,
        actionLabel: 'Reload',
        onAction: () => {
          // Activate the waiting SW and reload to the new build.
          void updateSW(true);
        },
      });
    },
    onOfflineReady() {
      useNotificationStore.getState().success('DocuShark is ready to work offline.');
    },
  });
}
