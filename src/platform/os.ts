/**
 * `platform.os` — coarse host-OS detection + desktop-vs-web shell.
 *
 * Derived from the browser/webview navigator on both shells (the Tauri
 * webview's user-agent reflects the host OS), so there is no `.tauri`/`.web`
 * split. `isDesktop()` reports whether we're in the Tauri shell. A native
 * `@tauri-apps/plugin-os` source (for arch/version detail) can replace the
 * desktop branch later behind this same interface.
 */

import { IS_TAURI } from './runtime';

export type OsKind = 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'unknown';

export interface OsInfo {
  /** Coarse host OS family. */
  kind(): OsKind;
  /** True when running inside the Tauri desktop shell. */
  isDesktop(): boolean;
}

function detectKind(): OsKind {
  if (typeof navigator === 'undefined') return 'unknown';
  // `userAgentData.platform` is the modern signal; fall back to UA string.
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  const raw = (uaData?.platform ?? navigator.userAgent ?? '').toLowerCase();
  if (/iphone|ipad|ipod/.test(raw)) return 'ios';
  if (/android/.test(raw)) return 'android';
  if (/mac/.test(raw)) return 'macos';
  if (/win/.test(raw)) return 'windows';
  if (/linux|x11/.test(raw)) return 'linux';
  return 'unknown';
}

export const os: OsInfo = {
  kind: detectKind,
  isDesktop: () => IS_TAURI,
};
