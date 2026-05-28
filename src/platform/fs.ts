/**
 * `platform.fs` — native filesystem access. Backed by `@tauri-apps/plugin-fs`
 * + `@tauri-apps/api/path` on desktop; **null on web**.
 *
 * The current consumers (relay-document disk cache, atomic crash-safe writes,
 * the team-document migration) are inherently desktop features — on the PWA
 * they short-circuit to "file system not available," exactly as they did when
 * they called the Tauri plugins directly. A web implementation (OPFS /
 * File System Access API) belongs with the PWA document-storage work and is
 * intentionally out of scope here; `getFileSystem()` returns `null` on web and
 * callers treat that as unavailable.
 */

/** A directory entry from {@link FileSystem.readDir}. */
export interface FileSystemDirEntry {
  name: string;
}

/** The subset of the Tauri fs/path surface the app relies on. */
export interface FileSystem {
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  readDir(path: string): Promise<FileSystemDirEntry[]>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Absolute path of the app-data directory (trailing separator included). */
  appDataDir(): Promise<string>;
}

let cached: Promise<FileSystem | null> | null = null;

/**
 * Resolve the platform filesystem, or `null` when none is available (web).
 * The impl is cached after the first call.
 */
export function getFileSystem(): Promise<FileSystem | null> {
  if (!cached) {
    cached = __IS_TAURI__
      ? import('./fs.tauri').then((m) => m.createTauriFileSystem())
      : Promise.resolve(null);
  }
  return cached;
}
