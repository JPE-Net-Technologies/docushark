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

import type { DiagramDocument, Page } from '../types/Document';
import { DOCUMENT_VERSION } from '../types/Document';
import type { Shape, GroupShape } from '../shapes/Shape';

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
 * Always-on, version-independent document invariants (JP-347, pre-GA posture
 * hardening). Idempotent and data-preserving — applied to *every* document on
 * the way in (not just on a version bump), so freshly-authored content is held
 * to the same shape as migrated content:
 *
 * - **Group ownership normalized**: a group whose `ownerId` is `undefined`
 *   (created before ownership was tracked, or by a path that omits it) is
 *   stamped `ownerId: null` — the explicit "SYSTEM-owned, no restrictions"
 *   value. This removes the `undefined`-vs-`null` ambiguity from documents so
 *   future migrations can reason about ownership unambiguously. Behaviour is
 *   unchanged: `permissionStore` already treats a missing owner and `null`
 *   identically (everyone may edit).
 * - **Active page ids self-healed**: the canvas `activePageId` (required) is
 *   repointed to a real page if it dangles, and the prose
 *   `richTextPages.activePageId` to a real prose page or `null`. Canvas and
 *   prose stay independent (separate tab strips, JP-339) — this only repairs
 *   dangling references, it does not unify them.
 */
function normalizeInvariants(doc: DiagramDocument): DiagramDocument {
  return healActivePageIds(backfillGroupOwnership(doc));
}

/** Stamp `ownerId: null` on any group shape missing it. Pure; returns the same
 * reference when nothing changed. */
function backfillGroupOwnership(doc: DiagramDocument): DiagramDocument {
  let docChanged = false;
  const pages: Record<string, Page> = {};

  for (const [pageId, page] of Object.entries(doc.pages)) {
    let pageChanged = false;
    const shapes: Record<string, Shape> = {};

    for (const [shapeId, shape] of Object.entries(page.shapes)) {
      // `type === 'group'` alone doesn't exclude LibraryShape (its `type` is a
      // dynamic string), so narrow to the real GroupShape before touching owner.
      const grp = shape.type === 'group' ? (shape as GroupShape) : undefined;
      if (grp && grp.ownerId === undefined) {
        shapes[shapeId] = { ...grp, ownerId: null };
        pageChanged = true;
      } else {
        shapes[shapeId] = shape;
      }
    }

    pages[pageId] = pageChanged ? { ...page, shapes } : page;
    docChanged ||= pageChanged;
  }

  return docChanged ? { ...doc, pages } : doc;
}

/** Repoint dangling canvas + prose active page ids to a real page. Pure. */
function healActivePageIds(doc: DiagramDocument): DiagramDocument {
  let result = doc;

  // Canvas: activePageId is required and must reference an existing page.
  const canvasIds = Object.keys(result.pages);
  if (canvasIds.length > 0 && !result.pages[result.activePageId]) {
    const next = result.pageOrder.find((id) => result.pages[id]) ?? canvasIds[0]!;
    result = { ...result, activePageId: next };
  }

  // Prose: activePageId may be null, but if set must reference a real page.
  const rtp = result.richTextPages;
  if (rtp) {
    const active = rtp.activePageId;
    const proseValid = active != null && rtp.pages[active] !== undefined;
    if (!proseValid) {
      const proseIds = Object.keys(rtp.pages);
      const next = proseIds.length > 0 ? (rtp.pageOrder.find((id) => rtp.pages[id]) ?? proseIds[0]!) : null;
      if (next !== active) {
        result = { ...result, richTextPages: { ...rtp, activePageId: next } };
      }
    }
  }

  return result;
}

/**
 * Ordered registry of *structural* format migrations, ascending by `to`. Empty
 * today — the v2 bump (JP-347) is carried entirely by the always-on
 * `normalizeInvariants` below rather than a one-shot transform. Structural,
 * version-specific reshapes (field renames, moves) go here.
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

  // Always-on, version-independent invariants (idempotent) — applied to every
  // document regardless of its declared version, so freshly-authored content is
  // held to the same shape as migrated content.
  result = normalizeInvariants(result);

  // Stamp the current version (also normalizes a missing/old stamp on an
  // already-structurally-current document).
  return result.version === DOCUMENT_VERSION ? result : { ...result, version: DOCUMENT_VERSION };
}
