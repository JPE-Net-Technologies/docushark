/**
 * The y-indexeddb room key for a relay-backed document's local Y.Doc.
 *
 * Scoped per relay host + doc id (JP-108 / JP-117) so the same doc on a
 * different relay can't bleed. This is the SINGLE source of the key: both the
 * live collab session (collaborationStore) and the offline prefetch
 * (prefetchYdoc, JP-335) derive it here, so a prefetched seed and the live
 * session bind the *same* room — a mismatch would silently strand the seed.
 *
 * `serverUrl` is the session's WebSocket URL (e.g. `wss://host/ws`); only its
 * `host` (host:port) is used, which is identical for the ws and http forms of
 * the same relay.
 */
export function collabIdbRoom(serverUrl: string, documentId: string): string {
  return `${new URL(serverUrl).host}:${documentId}`;
}
