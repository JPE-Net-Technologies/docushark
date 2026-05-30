/**
 * Tauri implementation of {@link relayFetch}. Routes relay HTTP through the
 * reqwest-backed `@tauri-apps/plugin-http` `fetch` instead of the webview's own
 * `fetch` (WebKitGTK/libsoup), which throttles large request bodies to
 * 15–80 KB/s (JP-127). This module is only imported in the desktop build
 * (gated by `__IS_TAURI__` in `./relayFetch`).
 *
 * Requires the `http:default` capability scoped to the relay origins in
 * `src-tauri/capabilities/default.json`.
 */

import { fetch as tauriHttpFetch } from '@tauri-apps/plugin-http';

export function createTauriRelayFetch(): typeof fetch {
  // The plugin's fetch is web-fetch-compatible (method / headers / body /
  // AbortSignal) but moves bytes through Rust/reqwest. Cast through `unknown`
  // because its signature carries extra `ClientOptions` beyond the DOM `fetch`.
  return tauriHttpFetch as unknown as typeof fetch;
}
