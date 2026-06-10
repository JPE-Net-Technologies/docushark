/**
 * Reference ingest (JP-89 slice 2).
 *
 * Turns external bibliographic input into normalized CSL-JSON {@link CSLItem}s:
 *   - `parseReferences` — BibTeX (via lazy-loaded `@citation-js`) or CSL-JSON
 *     (native `JSON.parse`), format auto-detected or forced.
 *   - `resolveDoi` — a single DOI resolved to CSL-JSON via content negotiation
 *     against `doi.org`, which transparently routes to the registration agency
 *     (Crossref **or** DataCite), so one path covers both.
 *
 * Everything here is **safe-parse**: functions never throw on bad input — they
 * return whatever parsed plus an {@link IngestReport} of errors/warnings. The
 * `@citation-js` import is dynamic so the (heavy) library stays out of the core
 * PWA bundle; the network transport is injectable so callers/tests control it.
 */

import type { CSLItem } from '../../types/Citation';

/** Recognized local input formats. `'doi'` is network-resolved, not parsed. */
export type IngestFormat = 'bibtex' | 'csl-json';
export type IngestSource = IngestFormat | 'doi';

export interface IngestReport {
  source: IngestSource;
  /** Number of items successfully produced. */
  count: number;
  errors: string[];
  warnings: string[];
}

export interface IngestResult {
  items: CSLItem[];
  report: IngestReport;
}

/** Injectable dependencies for {@link resolveDoi} (tests pass a mock fetch). */
export interface DoiDeps {
  fetch?: typeof fetch;
}

const CSL_JSON_DOI_ACCEPT = 'application/vnd.citationstyles.csl+json';

/**
 * Best-effort format detection for pasted/dropped text. Returns `null` when the
 * text matches neither shape (caller can surface "unrecognized format").
 */
export function detectFormat(text: string): IngestFormat | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return 'csl-json';
  // BibTeX entries open with `@type{key,` (also @string/@preamble/@comment).
  if (/^@[a-zA-Z]+\s*[{(]/.test(trimmed)) return 'bibtex';
  return null;
}

/**
 * Coerce an untrusted parsed object into a {@link CSLItem}, guaranteeing a
 * non-empty `id` and `type`. Returns `null` if it isn't an object at all.
 */
export function normalizeItem(raw: unknown, fallbackId: string): CSLItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj['id'] === 'string' && obj['id'].trim() ? (obj['id'] as string) : fallbackId;
  const type = typeof obj['type'] === 'string' && obj['type'].trim() ? (obj['type'] as string) : 'document';
  return { ...obj, id, type };
}

/**
 * Parse a block of reference text. `format` forces the parser; omit it to
 * auto-detect. Never throws.
 */
export async function parseReferences(text: string, format?: IngestFormat): Promise<IngestResult> {
  const resolved = format ?? detectFormat(text);
  if (resolved === null) {
    return {
      items: [],
      report: { source: 'csl-json', count: 0, errors: ['Unrecognized reference format'], warnings: [] },
    };
  }
  return resolved === 'bibtex' ? parseBibTeX(text) : parseCslJson(text);
}

async function parseBibTeX(text: string): Promise<IngestResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let items: CSLItem[] = [];
  try {
    // Lazy-load citation-js (heavy) only when BibTeX is actually ingested.
    const { Cite } = await import('@citation-js/core');
    await import('@citation-js/plugin-bibtex');
    const cite = new Cite(text, { forceType: '@bibtex/text' });
    items = cite.data
      .map((entry, i) => normalizeItem(entry, `ref-bibtex-${i}`))
      .filter((item): item is CSLItem => item !== null);
    if (items.length === 0) {
      warnings.push('No BibTeX entries found');
    }
  } catch (err) {
    errors.push(`BibTeX parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { items, report: { source: 'bibtex', count: items.length, errors, warnings } };
}

function parseCslJson(text: string): IngestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const items: CSLItem[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      items: [],
      report: {
        source: 'csl-json',
        count: 0,
        errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
        warnings: [],
      },
    };
  }
  const rawItems = Array.isArray(parsed) ? parsed : [parsed];
  rawItems.forEach((raw, i) => {
    const item = normalizeItem(raw, `ref-csl-${i}`);
    if (item) {
      items.push(item);
    } else {
      warnings.push(`Skipped non-object entry at index ${i}`);
    }
  });
  return { items, report: { source: 'csl-json', count: items.length, errors, warnings } };
}

/**
 * Strip common DOI prefixes/wrappers to a bare DOI (`10.xxxx/yyyy`).
 */
export function normalizeDoi(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/^info:doi\//i, '')
    .trim();
}

/**
 * Resolve a single DOI to a CSL-JSON {@link CSLItem} via `doi.org` content
 * negotiation. The fetch transport is injectable (defaults to global `fetch`)
 * so tests run offline and desktop can swap in a non-CORS transport later.
 * Never throws.
 */
export async function resolveDoi(doi: string, deps: DoiDeps = {}): Promise<IngestResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const bare = normalizeDoi(doi);
  const errors: string[] = [];
  const emptyReport = (msg: string): IngestResult => ({
    items: [],
    report: { source: 'doi', count: 0, errors: [msg], warnings: [] },
  });

  if (!bare || !/^10\.\d{4,9}\//.test(bare)) {
    return emptyReport(`Not a valid DOI: "${doi}"`);
  }
  if (typeof fetchImpl !== 'function') {
    return emptyReport('No fetch implementation available for DOI lookup');
  }

  let res: Response;
  try {
    res = await fetchImpl(`https://doi.org/${bare}`, {
      headers: { Accept: CSL_JSON_DOI_ACCEPT },
      redirect: 'follow',
    });
  } catch (err) {
    return emptyReport(`DOI lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (res.status === 404) return emptyReport(`DOI not found: ${bare}`);
  if (!res.ok) return emptyReport(`DOI lookup failed (HTTP ${res.status})`);

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return emptyReport(`DOI response was not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // CSL-JSON from doi.org carries `DOI` but usually no `id`; key it off the DOI.
  const fallbackId =
    typeof (body as Record<string, unknown>)?.['DOI'] === 'string'
      ? ((body as Record<string, unknown>)['DOI'] as string)
      : bare;
  const item = normalizeItem(body, fallbackId);
  if (!item) return emptyReport('DOI response was not a CSL item');

  return { items: [item], report: { source: 'doi', count: 1, errors, warnings: [] } };
}
