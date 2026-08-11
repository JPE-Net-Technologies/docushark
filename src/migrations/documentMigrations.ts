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
import { mintBlockId } from '../utils/blockIds';
import { headingHrefById, parseHeadingHref } from '../utils/headingLinks';

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
 * - **Heading ids minted + positional links rewritten** (JP-432 Pillar C):
 *   id-less `h1..h6` in stored prose HTML gain a durable `id="blk-…"`, and
 *   resolvable legacy positional heading links
 *   (`docushark://heading/<pageId>/<index>`) are rewritten to the drift-proof
 *   id form in the same pass. See `mintHeadingIdsAndRewriteLinks`.
 */
function normalizeInvariants(doc: DiagramDocument): DiagramDocument {
  return liftRestoredProvenance(
    mintHeadingIdsAndRewriteLinks(healActivePageIds(backfillGroupOwnership(doc))),
  );
}

/**
 * Matches a trailing `(Restored <something>)`, where `<something>` holds no
 * parentheses of its own. Anchored to the END and non-nesting on purpose: a
 * name that compounded (`X (Restored A) (Restored B)`) is peeled one suffix at
 * a time, newest first.
 */
const RESTORED_SUFFIX = /^(.*?)\s*\(Restored\s+([^()]+)\)\s*$/;

/** Earliest plausible restore stamp — the product did not exist before this. */
const PLAUSIBLE_FROM = Date.UTC(2020, 0, 1);

/**
 * Parse a legacy suffix's timestamp, or null when it isn't one.
 *
 * The suffix was written with `toLocaleString()`, so its exact shape depends on
 * the locale of the machine that produced it. Rather than try to reverse every
 * locale, this accepts only what `Date.parse` understands AND what lands in a
 * plausible window — so a deliberately-titled `Notes (Restored from backup)`
 * fails the test and keeps its name, which is the point.
 */
function parseRestoredStamp(raw: string): number | null {
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) return null;
  // A day of slack ahead of now absorbs clock skew between devices.
  if (ms < PLAUSIBLE_FROM || ms > Date.now() + 86_400_000) return null;
  return ms;
}

/**
 * Peel every machine-generated `(Restored <timestamp>)` off a document name.
 *
 * Returns the cleaned name plus the newest timestamp found (`null` when there
 * was nothing to lift). Exported because the restore path needs the same
 * parsing on a name it's handed directly, not just on a stored document —
 * otherwise restoring a legacy-named document would nest the suffix again.
 *
 * Peeling repeatedly cleans names that already compounded; the FIRST match (the
 * outermost, newest suffix) is the one reported.
 */
export function stripRestoredSuffix(rawName: string): {
  name: string;
  restoredFrom: number | null;
} {
  let name = rawName;
  let newest: number | null = null;

  // Bounded: every pass removes one suffix, and a name is finite.
  for (;;) {
    const match = RESTORED_SUFFIX.exec(name);
    if (!match) break;
    const stamp = parseRestoredStamp(match[2]!);
    // Unparseable means it probably wasn't machine-generated — stop here and
    // leave this suffix (and anything left of it) alone.
    if (stamp === null) break;
    if (newest === null) newest = stamp;
    name = match[1]!;
  }

  const trimmed = name.trim();
  // A name that was ONLY a suffix would end up empty; keep the original rather
  // than leave the document nameless.
  if (trimmed.length === 0) return { name: rawName, restoredFrom: null };
  return { name: trimmed, restoredFrom: newest };
}

/**
 * Lift `Name (Restored <timestamp>)` out of the title and into `restoredFrom`
 * (JP-481). Pure and idempotent — a document with no such suffix, or with an
 * unparseable one, is returned by reference. An existing `restoredFrom` is
 * never overwritten.
 */
export function liftRestoredProvenance(doc: DiagramDocument): DiagramDocument {
  const { name, restoredFrom: newest } = stripRestoredSuffix(doc.name);

  if (name === doc.name) return doc;

  // Conditional spread, not `restoredFrom: … ?? undefined` — the project runs
  // `exactOptionalPropertyTypes`, where an explicit `undefined` is not the same
  // as an absent key.
  const stamp = doc.restoredFrom ?? newest;
  return {
    ...doc,
    name: name.trim(),
    ...(stamp !== null && stamp !== undefined ? { restoredFrom: stamp } : {}),
  };
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
 * Mint durable heading ids + rewrite positional heading links (JP-432
 * Pillar C). Idempotent and pure — a second run finds every heading already
 * id-carrying and every resolvable link already in id form. Only pages where
 * something was actually minted or rewritten are re-serialized (change-flag,
 * not string compare — DOMParser normalizes HTML, and an untouched page must
 * keep its exact stored bytes).
 *
 * Reaches only the stored `richTextPages` HTML (local docs + the JSON mirror).
 * A live collab doc's CRDT fragment is authoritative and untouched here — its
 * ids arrive via the editor's mint sweep (`BlockIdExtension`) or the relay's
 * MCP fill; this pass repairs everything the sweep can't reach.
 */
function mintHeadingIdsAndRewriteLinks(doc: DiagramDocument): DiagramDocument {
  const rtp = doc.richTextPages;
  if (!rtp) return doc;
  const pageIds = Object.keys(rtp.pages);
  if (pageIds.length === 0) return doc;

  // Pass 1: mint ids onto id-less (or per-page duplicate) headings, building
  // the (pageId, index) -> id map that resolves positional links — including
  // cross-page ones, which is why minting completes before any rewrite.
  const parsed = new Map<string, { dom: Document; changed: boolean }>();
  const idByPosition = new Map<string, string>();
  for (const pageId of pageIds) {
    const page = rtp.pages[pageId];
    if (!page || typeof page.content !== 'string' || page.content.length === 0) continue;
    const dom = new DOMParser().parseFromString(page.content, 'text/html');
    const entry = { dom, changed: false };
    const seen = new Set<string>();
    dom.body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el, i) => {
      if (!el.id || seen.has(el.id)) {
        el.id = mintBlockId();
        entry.changed = true;
      }
      seen.add(el.id);
      idByPosition.set(`${pageId}::${i}`, el.id);
    });
    parsed.set(pageId, entry);
  }

  // Pass 2: rewrite resolvable positional heading links to the id form. An
  // id-form link passes through; a positional link whose target page/index is
  // unknown stays as-is (the legacy grammar is accepted forever).
  for (const entry of parsed.values()) {
    entry.dom.body.querySelectorAll('a[href^="docushark://heading/"]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      const link = parseHeadingHref(href);
      if (!link || link.index === undefined) return;
      const id = idByPosition.get(`${link.pageId}::${link.index}`);
      if (id === undefined) return;
      a.setAttribute('href', headingHrefById(link.pageId, id));
      entry.changed = true;
    });
  }

  let docChanged = false;
  const pages: typeof rtp.pages = {};
  for (const pageId of pageIds) {
    const page = rtp.pages[pageId]!;
    const entry = parsed.get(pageId);
    if (entry?.changed) {
      pages[pageId] = { ...page, content: entry.dom.body.innerHTML };
      docChanged = true;
    } else {
      pages[pageId] = page;
    }
  }
  return docChanged ? { ...doc, richTextPages: { ...rtp, pages } } : doc;
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
