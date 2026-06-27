/**
 * "Install DocuShark" PWA hint — web build only.
 *
 * Chromium-family browsers fire `beforeinstallprompt` once the app meets the
 * installability criteria. We intercept it, stash the deferred event, and offer
 * a one-time, dismissible toast with an **Install** action that triggers the
 * browser's native install prompt. This is the in-app counterpart to the
 * "install it in a click" copy on the marketing site.
 *
 * Shown at most once per browser (a persisted flag), never when already running
 * as an installed standalone PWA, and never in the Tauri build (desktop has no
 * install concept — it tree-shakes out via `IS_TAURI`).
 *
 * iOS Safari doesn't fire `beforeinstallprompt` (install is a manual
 * Share → Add to Home Screen), so those users get no toast here; an iOS
 * instructions hint is a possible follow-up.
 */

import { IS_TAURI } from '../platform/runtime';
import { readBreakpointState } from '../ui/layout/useBreakpoint';
import { useNotificationStore } from '../store/notificationStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

/**
 * Minimal type for the non-standard install-prompt event — it isn't in TS's DOM
 * lib, and the codebase bans `any`.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** The most recent deferred prompt, captured until the user acts on it. */
let deferredPrompt: BeforeInstallPromptEvent | null = null;

/** Fire the stashed native install prompt, then forget it (single-use). */
async function promptInstall(): Promise<void> {
  const event = deferredPrompt;
  deferredPrompt = null;
  if (!event) return;
  await event.prompt();
  // `userChoice` resolves once the user accepts/dismisses. We don't branch on it
  // (the `appinstalled` listener covers the accepted case); awaiting just avoids
  // an unhandled rejection if the browser rejects the prompt.
  await event.userChoice.catch(() => undefined);
}

/** Surface the hint once, if eligible. */
function maybeShowHint(): void {
  if (!deferredPrompt) return;
  if (readBreakpointState().standalone) return; // already installed
  // The persisted flag is the cross-load + re-fire guard: it's set synchronously
  // below, so a second `beforeinstallprompt` in the same session is suppressed.
  if (useUIPreferencesStore.getState().installAppHintSeen) return;

  // Mark seen on show so the nudge appears at most once per browser, whether the
  // user installs or simply dismisses it.
  useUIPreferencesStore.getState().markInstallAppHintSeen();
  useNotificationStore
    .getState()
    .info('Install DocuShark — it opens in its own window and works offline.', {
      category: 'permanent',
      duration: 0,
      actionLabel: 'Install',
      onAction: () => {
        void promptInstall();
      },
    });
}

/**
 * Attach the install-prompt listeners. Call once at boot (web build only).
 * Returns a disposer that detaches them (used by tests; the app ignores it).
 * Safe under jsdom — it only registers `window` listeners.
 */
export function initInstallPrompt(): () => void {
  if (IS_TAURI || typeof window === 'undefined') return () => {};

  const onBeforeInstallPrompt = (event: Event): void => {
    // Suppress Chrome's default mini-infobar so our toast is the single entry point.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    maybeShowHint();
  };
  const onAppInstalled = (): void => {
    deferredPrompt = null;
    // Never nag after a successful install.
    if (!useUIPreferencesStore.getState().installAppHintSeen) {
      useUIPreferencesStore.getState().markInstallAppHintSeen();
    }
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onAppInstalled);

  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onAppInstalled);
  };
}
