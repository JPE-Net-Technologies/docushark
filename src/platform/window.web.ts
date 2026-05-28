/**
 * Web implementation of {@link WindowControls}. There is no OS window to
 * drive, so everything is a no-op and `isSupported()` is false — the in-app
 * titlebar's window buttons render nothing on the PWA.
 */

import type { WindowControls } from './window';

const noop = (): void => {};

export function createWebWindow(): WindowControls {
  return {
    isSupported() {
      return false;
    },
    setDecorations() {
      return Promise.resolve();
    },
    minimize() {
      return Promise.resolve();
    },
    toggleMaximize() {
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
    isMaximized() {
      return Promise.resolve(false);
    },
    onResized() {
      return Promise.resolve(noop);
    },
  };
}
