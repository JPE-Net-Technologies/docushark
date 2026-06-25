/**
 * Document version gate + migration dispatcher (JP-347).
 *
 * Pre-GA, the document format is still allowed to evolve, but once a stable
 * release ships the format freezes within a major version (see AGENTS.md
 * "Backwards Compatibility & Document Safety"). For that freeze to be
 * meaningful, *every* document entering the app must pass through a single,
 * ordered migration funnel:
 *
 *   1. A document whose `version` is **newer** than this build can support is
 *      rejected loudly (`DocumentVersionError`) instead of being silently
 *      mis-interpreted — the caller surfaces a notice rather than crashing or
 *      dropping data.
 *   2. A document whose `version` is **older** is walked up through the ordered
 *      `MIGRATIONS` registry to the current `DOCUMENT_VERSION`.
 *   3. The result is stamped with the current `DOCUMENT_VERSION`.
 *
 * `migrateDocument` is pure and idempotent: re-running it on an
 * already-current document is a no-op (no migration step matches, the version
 * stamp is unchanged). This is the chokepoint wired into every loader
 * (local-storage, relay fetch, cached, imported, restored-from-backup) so the
 * migration ceremony can never be forgotten on one path — a contract test
 * guards that.
 *
 * Adding a new format version (vN -> vN+1):
 *   - bump `DOCUMENT_VERSION` in `types/Document.ts`,
 *   - write a pure `migrateVNToVN1(doc)` that preserves all data,
 *   - append `{ to: N+1, migrate: migrateVNToVN1 }` to `MIGRATIONS`,
 *   - add a fixture of the old format + a round-trip "no data loss" test.
 */

import type { DiagramDocument } from '../types/Document';
import { DOCUMENT_VERSION } from '../types/Document';

/**
 * Thrown when a document declares a `version` greater than this build's
 * `DOCUMENT_VERSION`. Loaders should catch this and surface a user-facing
 * "created by a newer version of DocuShark" notice rather than attempting to
 * load (and risk silently mangling) a format they don't understand.
 */
export class DocumentVersionError extends Error {
  constructor(
    /** The document's declared schema version. */
    readonly documentVersion: number,
    /** The highest schema version this build supports. */
    readonly supportedVersion: number,
  ) {
    super(
      `This document was created by a newer version of DocuShark ` +
        `(document format v${documentVersion}; this app supports up to v${supportedVersion}). ` +
        `Update DocuShark to open it.`,
    );
    this.name = 'DocumentVersionError';
  }
}

/** A single ordered step: bring a document up to schema version `to`. */
interface Migration {
  /** The schema version this step produces. */
  to: number;
  /** Pure, data-preserving transform from the previous version to `to`. */
  migrate: (doc: DiagramDocument) => DiagramDocument;
}

/**
 * Ordered registry of format migrations, ascending by `to`. Empty until the
 * first format bump lands (the gate is useful on its own — it rejects
 * newer-than-supported documents and normalizes the version stamp).
 */
const MIGRATIONS: Migration[] = [];

/** Read a document's declared version, defaulting a missing/invalid one to 1. */
function readVersion(doc: DiagramDocument): number {
  return typeof doc.version === 'number' && Number.isFinite(doc.version) ? doc.version : 1;
}

/**
 * Run a raw, already-parsed document through the version gate + migration
 * chain and return it at the current `DOCUMENT_VERSION`.
 *
 * @throws {DocumentVersionError} if the document is newer than this build.
 */
export function migrateDocument(doc: DiagramDocument): DiagramDocument {
  const from = readVersion(doc);

  if (from > DOCUMENT_VERSION) {
    throw new DocumentVersionError(from, DOCUMENT_VERSION);
  }

  let result = doc;
  let current = from;
  for (const step of MIGRATIONS) {
    if (step.to > current && step.to <= DOCUMENT_VERSION) {
      result = step.migrate(result);
      current = step.to;
    }
  }

  // Stamp the current version (also normalizes a missing/old stamp on an
  // already-structurally-current document).
  return result.version === DOCUMENT_VERSION ? result : { ...result, version: DOCUMENT_VERSION };
}
