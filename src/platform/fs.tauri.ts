/**
 * Tauri implementation of {@link FileSystem}, wrapping `@tauri-apps/plugin-fs`
 * and `@tauri-apps/api/path`. Only imported in the desktop build (gated by
 * `__IS_TAURI__` in `./fs`).
 */

import * as fs from '@tauri-apps/plugin-fs';
import { appDataDir } from '@tauri-apps/api/path';
import type { FileSystem } from './fs';

export function createTauriFileSystem(): FileSystem {
  return {
    exists: (path) => fs.exists(path),
    mkdir: (path, options) => fs.mkdir(path, options),
    readTextFile: (path) => fs.readTextFile(path),
    writeTextFile: (path, content) => fs.writeTextFile(path, content),
    readFile: (path) => fs.readFile(path),
    writeFile: (path, content) => fs.writeFile(path, content),
    readDir: (path) => fs.readDir(path),
    rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
    remove: (path) => fs.remove(path),
    appDataDir: () => appDataDir(),
  };
}
