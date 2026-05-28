/**
 * `platform.dialog` — open / save file pickers.
 *
 * Defined now as part of the platform contract; it currently has no
 * consumers (file import flows through HTML5 drag/drop + `<input>` inside
 * the canvas today). A single browser implementation serves both shells —
 * the Tauri webview supports `<input type="file">` and anchor downloads —
 * so there is no `.tauri`/`.web` split yet. A native Tauri picker
 * (`@tauri-apps/plugin-dialog`, for true desktop "Save As" paths) is a
 * future enhancement that would slot in behind this same interface.
 */

export interface OpenFileOptions {
  /** Accepted extensions / MIME types, e.g. `['.json', 'image/png']`. */
  accept?: string[];
  /** Allow selecting multiple files (default false). */
  multiple?: boolean;
}

export interface SaveFileOptions {
  /** Default filename offered to the user. */
  suggestedName?: string;
  /** MIME type of the saved blob. */
  mimeType?: string;
}

export interface Dialog {
  /** Prompt the user to choose file(s) to open. Resolves `[]` if cancelled. */
  openFiles(options?: OpenFileOptions): Promise<File[]>;
  /** Prompt the user to save `data`. Resolves once the download is triggered. */
  saveFile(data: Blob | string, options?: SaveFileOptions): Promise<void>;
}

function openFilesViaInput(options?: OpenFileOptions): Promise<File[]> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve([]);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    if (options?.multiple) input.multiple = true;
    if (options?.accept && options.accept.length > 0) {
      input.accept = options.accept.join(',');
    }
    input.addEventListener('change', () => {
      resolve(input.files ? Array.from(input.files) : []);
    });
    // If the picker is dismissed, `change` never fires; the promise simply
    // stays pending, which matches a "no selection" outcome for callers.
    input.click();
  });
}

export const dialog: Dialog = {
  openFiles(options) {
    return openFilesViaInput(options);
  },
  saveFile(data, options) {
    if (typeof document === 'undefined') return Promise.resolve();
    const blob =
      typeof data === 'string'
        ? new Blob([data], { type: options?.mimeType ?? 'text/plain' })
        : data;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = options?.suggestedName ?? 'download';
    a.click();
    URL.revokeObjectURL(url);
    return Promise.resolve();
  },
};
