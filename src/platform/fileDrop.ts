/**
 * `platform.fileDrop` — native OS file-drop onto the window.
 *
 * Tauri intercepts OS-level file drags before the webview sees them, so
 * HTML5 `drop` events don't fire for *external* files in the desktop app.
 * The desktop impl listens for Tauri's `tauri://drag-drop` event and reads
 * the dropped files' bytes via the fs plugin. On web there is no native
 * bridge — browser file drops arrive as ordinary HTML5 events handled by
 * the canvas directly — so the web impl is a no-op.
 */

/** A file read from a native drop, ready to wrap in a `File`. */
export interface DroppedFile {
  bytes: Uint8Array;
  fileName: string;
}

export interface FileDropEvent {
  files: DroppedFile[];
  /** OS physical screen coordinates of the drop point. */
  position: { x: number; y: number };
}

export interface FileDropSource {
  /**
   * Subscribe to native file drops. Resolves to an unlisten function.
   * No-op on web (returns a noop unlisten).
   */
  onFileDrop(handler: (event: FileDropEvent) => void): Promise<() => void>;
}

let cached: Promise<FileDropSource> | null = null;

function resolve(): Promise<FileDropSource> {
  if (!cached) {
    cached = __IS_TAURI__
      ? import('./fileDrop.tauri').then((m) => m.createTauriFileDrop())
      : import('./fileDrop.web').then((m) => m.createWebFileDrop());
  }
  return cached;
}

export const fileDrop: FileDropSource = {
  onFileDrop: (handler) => resolve().then((s) => s.onFileDrop(handler)),
};
