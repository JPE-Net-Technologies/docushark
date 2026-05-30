/**
 * Web implementation of {@link relayFetch}. The browser's native `fetch`
 * handles large uploads fine, so this is just the platform `fetch`.
 */

export function createWebRelayFetch(): typeof fetch {
  return globalThis.fetch.bind(globalThis) as typeof fetch;
}
