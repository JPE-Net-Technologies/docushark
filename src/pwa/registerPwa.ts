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

export function registerPwa(): void {
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
