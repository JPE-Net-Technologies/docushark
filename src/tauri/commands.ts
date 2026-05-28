/**
 * Back-compat shim.
 *
 * The Tauri command surface moved to `src/platform/` — the single place
 * `@tauri-apps/*` may be imported (see JP-76 platform abstraction). This file
 * re-exports the runtime detector and opener wrappers so existing
 * `../tauri/commands` importers keep working. New code should import the
 * specific capability from `src/platform/` directly.
 */

import { opener } from '../platform/opener';

export { isTauri } from '../platform/runtime';

export const openDocs = (): Promise<void> => opener.openDocs();
export const openExternalUrl = (url: string): Promise<void> => opener.openExternalUrl(url);
export const applyCustomChrome = (enabled: boolean): Promise<void> =>
  opener.applyCustomChrome(enabled);
export const persistCustomChrome = (enabled: boolean): Promise<void> =>
  opener.persistCustomChrome(enabled);
