/**
 * The single REST-body choke point (JP-423).
 *
 * Every document body bound for the relay over REST — a live save or a queued
 * replay — MUST pass through this function. It is applied inside the two deep
 * seams, so all existing paths are covered without their callers knowing:
 *
 *  - `relayDocumentStore.saveToHost` — at the wire, immediately before
 *    `docProvider.saveDocument(...)`.
 *  - `SyncStateManager.queueSave` — before the body is enqueued for replay.
 *
 * A new REST path (e.g. an integration flow pushing bodies from a non-editor
 * context) should route through those seams; one that cannot must call this
 * function itself, LAST, immediately before the wire. The
 * `restWriteBoundary.test.ts` allowlist polices who may call the seams.
 *
 * Contract:
 *  - Idempotent — applying twice equals applying once.
 *  - Non-mutating — returns the input unchanged (by reference) when there is
 *    nothing to do, a modified copy otherwise.
 *  - REST-boundary only — local caches and stores must keep the FULL body;
 *    never feed the return value back into a cache put.
 *
 * Current steps: blank pending-sync pages' prose so a replay can never make
 * the relay's JSON-hydration seeder mint a competing prose lineage (JP-335,
 * the JP-282 double). Future sanitization steps compose here; they must
 * copy-and-override rather than rebuild objects from known fields, so new
 * page/meta fields survive by default.
 */

import type { DiagramDocument } from '../types/Document';
import { withholdPendingProseFromBody } from './pendingSyncPages';

export function serializeDocForRest(doc: DiagramDocument): DiagramDocument {
  return withholdPendingProseFromBody(doc);
}
