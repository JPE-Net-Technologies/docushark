/**
 * Tauri IPC Commands
 *
 * Phase 20.3 Slice E.4: the renderer no longer drives any of the
 * pre-extraction Tauri commands — Protected Local hosting, JWT auth,
 * team-document CRUD, and the embedded MCP server all moved to the
 * standalone `diagrammer-relay` binary (REST + WS). What remains is
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
 * Open the Diagrammer docs site in the system browser via Tauri's
 * opener plugin. No-op in the web build (caller should fall back to
 * `window.open`).
 */
export async function openDocs(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('open_docs');
}
