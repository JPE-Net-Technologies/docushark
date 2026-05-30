/**
 * `platform.relayFetch` — the `fetch` used by `RelayClient` for relay REST +
 * blob HTTP.
 *
 * Desktop routes through the reqwest-backed Tauri HTTP plugin because the
 * webview's own `fetch` (WebKitGTK/libsoup) throttles large request bodies to
 * 15–80 KB/s (JP-127); web/PWA uses the native `fetch`, which is fine. The
 * `@tauri-apps/plugin-http` import lives in `./relayFetch.tauri` so it is
 * tree-shaken out of the PWA bundle (the `__IS_TAURI__`-gated dynamic import,
 * same pattern as `./opener`).
 *
 * The impl resolves asynchronously (dynamic import) but is exposed as a
 * synchronous `fetch`-shaped function — it awaits + caches the platform impl on
 * first call — so `RelayClient` (which takes a synchronous `fetchImpl`) and its
 * `AbortController` timeout (JP-127) need no change.
 */

let cached: Promise<typeof fetch> | null = null;

function resolveRelayFetch(): Promise<typeof fetch> {
  if (!cached) {
    // `__IS_TAURI__` is a build-time literal — the false branch (and its
    // `@tauri-apps` import) is dead-code-eliminated from the PWA bundle.
    cached = __IS_TAURI__
      ? import('./relayFetch.tauri').then((m) => m.createTauriRelayFetch())
      : import('./relayFetch.web').then((m) => m.createWebRelayFetch());
  }
  return cached;
}

/**
 * A `fetch`-compatible function backed by the platform's preferred HTTP
 * transport. Pass as `RelayClient`'s `fetchImpl`.
 */
export const relayFetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => resolveRelayFetch().then((f) => f(input, init))) as unknown as typeof fetch;
