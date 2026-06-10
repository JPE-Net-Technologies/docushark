/**
 * Citation / reference types for the per-document reference library (JP-89).
 *
 * The canonical interchange shape is **CSL-JSON** (Citation Style Language) —
 * the same structure `@citation-js` and DOI content-negotiation
 * (`application/vnd.citationstyles.csl+json`) both emit and consume. Storing
 * references as CSL-JSON now means later slices (BibTeX/DOI ingest, CSL
 * formatting, the Tiptap inline-cite + bibliography nodes, the MCP surface)
 * feed straight in with no re-modelling.
 *
 * This file is the data model only — no formatting, ingest, or network logic
 * (those land in subsequent JP-89 slices).
 */

/**
 * A CSL name (author / editor / etc.). Either a structured `family`/`given`
 * pair or a `literal` for institutional / unparsed names.
 */
export interface CSLName {
  family?: string;
  given?: string;
  /** Whole-name fallback (organisations, "et al.", unparsed names). */
  literal?: string;
}

/**
 * A CSL date. CSL encodes dates as nested `date-parts` (`[[year, month, day]]`,
 * each part optional from the right) with a `raw` string fallback for dates
 * that don't parse into parts.
 */
export interface CSLDate {
  'date-parts'?: number[][];
  raw?: string;
}

/**
 * A single CSL-JSON bibliographic item.
 *
 * The commonly-used fields are modelled explicitly; the `[key: string]: unknown`
 * index signature carries the long tail of the CSL spec (~50 fields) without
 * resorting to `any`. Accessing an explicit field uses dot notation; accessing
 * an extra CSL field uses bracket notation (per `noPropertyAccessFromIndexSignature`).
 */
export interface CSLItem {
  /** Citekey / unique id within the document's library. Required. */
  id: string;
  /** CSL item type, e.g. `article-journal`, `book`, `webpage`. */
  type: string;
  title?: string;
  author?: CSLName[];
  editor?: CSLName[];
  issued?: CSLDate;
  DOI?: string;
  URL?: string;
  ISBN?: string;
  'container-title'?: string;
  publisher?: string;
  page?: string;
  volume?: string;
  issue?: string;
  abstract?: string;
  /** Long tail of CSL fields not modelled explicitly. */
  [key: string]: unknown;
}

/**
 * A document's reference library: CSL items keyed by id, plus an explicit
 * display order. Mirrors the id-map + order-array shape of `Page` / `RichTextPage`.
 */
export interface ReferenceLibrary {
  items: Record<string, CSLItem>;
  itemOrder: string[];
}

/**
 * Create an empty reference library.
 */
export function createEmptyReferenceLibrary(): ReferenceLibrary {
  return { items: {}, itemOrder: [] };
}

/**
 * Runtime guard: is `x` a structurally-valid {@link ReferenceLibrary}?
 *
 * Used to defensively normalize untrusted input (e.g. an imported document or
 * a partial snapshot) before loading it into the store — a malformed value
 * should degrade to an empty library, never throw.
 */
export function isReferenceLibrary(x: unknown): x is ReferenceLibrary {
  if (!x || typeof x !== 'object') return false;
  const lib = x as Record<string, unknown>;
  return (
    typeof lib['items'] === 'object' &&
    lib['items'] !== null &&
    !Array.isArray(lib['items']) &&
    Array.isArray(lib['itemOrder'])
  );
}
