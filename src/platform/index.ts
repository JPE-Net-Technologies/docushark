/**
 * Platform abstraction layer — the capability contract shared by the Tauri
 * desktop shell and the PWA. Editor code talks to `platform.*` instead of
 * importing `@tauri-apps/*` directly; `src/platform/` is the only place those
 * imports are allowed, and each capability's Tauri implementation is gated by
 * the build-time `__IS_TAURI__` flag so the web bundle tree-shakes it out.
 *
 * See the Final OSS App Design §2. The `sync` / `localRelay` / `mcp` /
 * `update` capabilities sketched there are intentionally absent: they already
 * live in the standalone relay binary and aren't reached from the renderer.
 */

import { IS_TAURI } from './runtime';
import { opener, type Opener } from './opener';
import { windowControls, type WindowControls } from './window';
import { getFileSystem } from './fs';
import { fileDrop, type FileDropSource } from './fileDrop';
import { secureStore, type SecureStore } from './secureStore';
import { dialog, type Dialog } from './dialog';
import { os, type OsInfo } from './os';
import { device, type DeviceHints } from './device';

/** The full set of platform capabilities the editor depends on. */
export interface PlatformCapabilities {
  /** Build-time desktop flag (`__IS_TAURI__`). */
  readonly isTauri: boolean;
  readonly opener: Opener;
  readonly window: WindowControls;
  readonly fileDrop: FileDropSource;
  readonly secureStore: SecureStore;
  readonly dialog: Dialog;
  readonly os: OsInfo;
  readonly device: DeviceHints;
  /** Resolve the native filesystem, or `null` on web. */
  readonly getFileSystem: typeof getFileSystem;
}

/** The singleton platform façade. */
export const platform: PlatformCapabilities = {
  isTauri: IS_TAURI,
  opener,
  window: windowControls,
  fileDrop,
  secureStore,
  dialog,
  os,
  device,
  getFileSystem,
};

// Direct re-exports — most consumers import the specific capability they need
// (e.g. `import { opener } from '../platform/opener'`); these aggregate them.
export { isTauri, IS_TAURI } from './runtime';
export { opener, DOCS_URL } from './opener';
export type { Opener } from './opener';
export { windowControls } from './window';
export type { WindowControls } from './window';
export { getFileSystem } from './fs';
export type { FileSystem, FileSystemDirEntry } from './fs';
export { fileDrop } from './fileDrop';
export type { FileDropSource, FileDropEvent, DroppedFile } from './fileDrop';
export { secureStore } from './secureStore';
export type { SecureStore } from './secureStore';
export { dialog } from './dialog';
export type { Dialog, OpenFileOptions, SaveFileOptions } from './dialog';
export { os } from './os';
export type { OsInfo, OsKind } from './os';
export { device } from './device';
export type { DeviceHints, ViewportBand } from './device';
