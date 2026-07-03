/**
 * prefetchYdoc — seed a relay document's local Y.Doc room from the relay's
 * authoritative binary sidecar, so a "downloaded but never opened" doc can be
 * opened + edited OFFLINE (JP-422).
 *
 * The problem: the local y-indexeddb room (`host:docId`) is populated only by a
 * live sync handshake. A doc that was cached (body + blobs, JP-281) but never
 * opened while online has an EMPTY room, so opening it offline leaves the prose
 * fragment empty → the editor is read-only (relay-is-sole-seeder, JP-284), and
 * canvas edits can't be captured. Prefetching the relay's exact CRDT bytes into
 * that room fixes both: the offline adopt path sees real content and the client
 * edits the relay's own lineage, which dedupes trivially on reconnect.
 *
 * Correctness hinges on two things:
 *  - the seeded room key must byte-match the live session's — both go through
 *    {@link collabIdbRoom};
 *  - the bytes must be the relay's real lineage (a sidecar it will reproduce on
 *    reconnect), which the `GET /api/docs/:id/ydoc` endpoint guarantees (it only
 *    serves a persisted/live-handle sidecar, never a fresh JSON hydrate).
 */

import { Doc as YDoc, applyUpdate, encodeStateVector } from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { loadConnection } from '../api/relayConnection';
import { restUrlToWsUrl } from '../api/completeCloudSignIn';
import { getDocProvider } from '../store/relayDocumentStore';
import { collabIdbRoom } from './collabRoom';

/** An empty Yjs state vector — what an untouched room reports. */
const EMPTY_STATE_VECTOR_LEN = 1;

/**
 * Fetch `docId`'s authoritative Y.Doc sidecar and apply it into the local
 * y-indexeddb room so the doc can be opened offline. Resolves to:
 *  - `'seeded'` — bytes were fetched and written into a previously-empty room,
 *  - `'skipped'` — the room already had CRDT state (a prior sync/seed), or
 *  - `'unavailable'` — no relay/provider/sidecar, or IndexedDB is absent.
 *
 * Best-effort and idempotent: re-applying the same sidecar is a no-op, and any
 * failure leaves the doc on its existing (read-only) offline path — no throw.
 */
export async function prefetchYdoc(
  docId: string,
): Promise<'seeded' | 'skipped' | 'unavailable'> {
  if (typeof indexedDB === 'undefined') return 'unavailable';

  const provider = getDocProvider();
  if (!provider?.getYdoc) return 'unavailable';

  const conn = await loadConnection();
  if (!conn?.relayUrl) return 'unavailable';

  const room = collabIdbRoom(restUrlToWsUrl(conn.relayUrl), docId);

  // Bind the room and wait for any persisted state to load. If it already holds
  // CRDT state (the doc was synced/edited before), do NOT overwrite — the live
  // lineage wins; seeding on top is unnecessary and could reintroduce a merge.
  const doc = new YDoc();
  const persistence = new IndexeddbPersistence(room, doc);
  try {
    await persistence.whenSynced;
    if (encodeStateVector(doc).length > EMPTY_STATE_VECTOR_LEN) {
      return 'skipped';
    }

    const bytes = await provider.getYdoc(docId);
    if (!bytes || bytes.length === 0) return 'unavailable';

    // Strip the sidecar's `DSKY|ver|serverVersion` header (16 bytes) to get the
    // raw lib0-v1 state update; a short/garbage buffer just aborts the prefetch.
    const update = stripSidecarHeader(bytes);
    if (!update) return 'unavailable';

    // Apply with a non-`this` origin (default) so y-indexeddb's `update`
    // handler fires SYNCHRONOUSLY and creates the IDB write transaction before
    // we detach. `destroy()` below calls `db.close()`, which per the IndexedDB
    // spec lets that in-flight transaction complete — so the seed is durably
    // persisted for the live session to load.
    applyUpdate(doc, update);
    return 'seeded';
  } catch {
    return 'unavailable';
  } finally {
    // Detach our transient handle; the persisted room stays on disk for the live
    // session to pick up. `destroy()` also tears down the Y.Doc.
    await persistence.destroy();
    doc.destroy();
  }
}

/** Sidecar magic + header length — mirrors `relay/src/sync/binary.rs`. */
const SIDECAR_MAGIC = [0x44, 0x53, 0x4b, 0x59]; // "DSKY"
const SIDECAR_HEADER_LEN = 16; // magic(4) + format_version(4) + server_version(8)

/**
 * Validate the `DSKY` header and return the lib0-v1 update payload, or null if
 * the buffer isn't a recognizable sidecar (bad magic / too short). Exported for
 * testing.
 */
export function stripSidecarHeader(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length <= SIDECAR_HEADER_LEN) return null;
  for (let i = 0; i < SIDECAR_MAGIC.length; i++) {
    if (bytes[i] !== SIDECAR_MAGIC[i]) return null;
  }
  return bytes.subarray(SIDECAR_HEADER_LEN);
}
