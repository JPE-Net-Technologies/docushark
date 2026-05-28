/**
 * `platform.window` — native window controls (decorations, min/max/close,
 * resize events). Backed by `@tauri-apps/api/window` on desktop; a no-op on
 * web, where `isSupported()` returns false so the in-app titlebar controls
 * render nothing.
 */

import { IS_TAURI } from './runtime';

export interface WindowControls {
  /** Whether native window controls exist (desktop only). Synchronous. */
  isSupported(): boolean;
  /** Show (`true`) or hide (`false`) the OS window decorations. */
  setDecorations(visible: boolean): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Subscribe to window resize; resolves to an unlisten function. */
  onResized(handler: () => void): Promise<() => void>;
}

let cached: Promise<WindowControls> | null = null;

function resolve(): Promise<WindowControls> {
  if (!cached) {
    cached = __IS_TAURI__
      ? import('./window.tauri').then((m) => m.createTauriWindow())
      : import('./window.web').then((m) => m.createWebWindow());
  }
  return cached;
}

export const windowControls: WindowControls = {
  isSupported: () => IS_TAURI,
  setDecorations: (visible) => resolve().then((w) => w.setDecorations(visible)),
  minimize: () => resolve().then((w) => w.minimize()),
  toggleMaximize: () => resolve().then((w) => w.toggleMaximize()),
  close: () => resolve().then((w) => w.close()),
  isMaximized: () => resolve().then((w) => w.isMaximized()),
  onResized: (handler) => resolve().then((w) => w.onResized(handler)),
};
