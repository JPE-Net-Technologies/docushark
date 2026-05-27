/**
 * Web implementation of {@link FileDropSource}. Browsers deliver external
 * file drops as ordinary HTML5 `drop` events (handled on the canvas), so
 * there is no native bridge to subscribe to here — this is a no-op.
 */

import type { FileDropSource } from './fileDrop';

const noop = (): void => {};

export function createWebFileDrop(): FileDropSource {
  return {
    onFileDrop() {
      return Promise.resolve(noop);
    },
  };
}
