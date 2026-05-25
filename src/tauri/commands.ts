/**
 * Tauri IPC Commands
 *
 * Phase 20.3 Slice E.4: the renderer no longer drives any of the
 * pre-extraction Tauri commands — Protected Local hosting, JWT auth,
 * team-document CRUD, and the embedded MCP server all moved to the
 * standalone `docushark-relay` binary (REST + WS). What remains is
 * a tiny shell: `isTauri()` for runtime detection and `openDocs()`
 * which still uses Tauri's opener plugin to launch the docs site
 * outside the browser shell.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Check if running in the Tauri desktop shell. Tauri v2 uses
 * `__TAURI_INTERNALS__` instead of v1's `__TAURI__`; the older key
 * is checked too for resilience against older webview snapshots.
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

/**
 * Open the DocuShark docs site in the system browser via Tauri's
 * opener plugin. No-op in the web build (caller should fall back to
 * `window.open`).
 */
export async function openDocs(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('open_docs');
}

/**
 * Persist the `customChrome` flag to a Rust-readable file and restart
 * the app so the main window is rebuilt with the new decoration setting
 * from creation time. Needed for Linux WMs (Wayland tilers, older XFCE)
 * that ignore runtime `setDecorations` calls. No-op in the web build —
 * callers fall back to `window.location.reload()`.
 *
 * `enabled` means "custom chrome on" → native decorations off. This
 * call does not return on success: the process restarts.
 */
export async function applyCustomChrome(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('apply_custom_chrome', { enabled });
}

/**
 * Persist the `customChrome` flag without restarting. Used in dev mode
 * — `app.restart()` in `tauri dev` kills the cargo-spawned binary
 * without re-spawning it, so we just persist the flag and the developer
 * restarts `bun run tauri:dev` manually.
 */
export async function persistCustomChrome(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('persist_custom_chrome', { enabled });
}
