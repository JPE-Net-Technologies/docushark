/**
 * Tauri implementation of {@link WindowControls}, wrapping
 * `@tauri-apps/api/window`'s `getCurrentWindow`. Only imported in the
 * desktop build (gated by `__IS_TAURI__` in `./window`).
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import type { WindowControls } from './window';

export function createTauriWindow(): WindowControls {
  return {
    isSupported() {
      return true;
    },
    setDecorations(visible) {
      return getCurrentWindow().setDecorations(visible);
    },
    minimize() {
      return getCurrentWindow().minimize();
    },
    toggleMaximize() {
      return getCurrentWindow().toggleMaximize();
    },
    close() {
      return getCurrentWindow().close();
    },
    isMaximized() {
      return getCurrentWindow().isMaximized();
    },
    onResized(handler) {
      return getCurrentWindow().onResized(() => handler());
    },
  };
}
