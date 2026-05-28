/**
 * Tauri implementation of {@link FileDropSource}. Listens for the
 * `tauri://drag-drop` event and reads each dropped file's bytes via the fs
 * plugin, handing the consumer ready-to-wrap `DroppedFile`s plus the drop
 * position. Only imported in the desktop build (gated by `__IS_TAURI__` in
 * `./fileDrop`).
 */

import { listen } from '@tauri-apps/api/event';
import { readFile } from '@tauri-apps/plugin-fs';
import type { DroppedFile, FileDropSource } from './fileDrop';

interface TauriDragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

export function createTauriFileDrop(): FileDropSource {
  return {
    async onFileDrop(handler) {
      return listen<TauriDragDropPayload>('tauri://drag-drop', async (event) => {
        const { paths, position } = event.payload;
        if (paths.length === 0) return;

        const files: DroppedFile[] = [];
        for (const filePath of paths) {
          try {
            const bytes = await readFile(filePath);
            const fileName = filePath.split(/[\\/]/).pop() || 'unknown';
            files.push({ bytes, fileName });
          } catch (err) {
            console.error('Failed to read dropped file:', filePath, err);
          }
        }

        if (files.length > 0) {
          handler({ files, position });
        }
      });
    },
  };
}
