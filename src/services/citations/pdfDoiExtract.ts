/**
 * DOI extraction from PDF-derived text (metadata fields + page text). Pure
 * string logic so ranking/trimming is unit-testable without pdf.js.
 */

/** Registrant prefix `10.NNNN/` followed by a suffix (no whitespace). */
const DOI_PATTERN = /\b10\.\d{4,9}\/\S+/g;

/**
 * Punctuation that ends a sentence around a DOI but is never meaningfully the
 * end of one. Balanced trailing parens do occur in real DOIs, so `)` is only
 * trimmed when unbalanced within the match.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"”’]+$/;

function trimDoi(raw: string): string {
  let doi = raw.replace(TRAILING_PUNCTUATION, '');
  // Trim unbalanced closing brackets picked up from surrounding prose.
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    while (doi.endsWith(close)) {
      const opens = doi.split(open).length - 1;
      const closes = doi.split(close).length - 1;
      if (closes > opens) doi = doi.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
      else break;
    }
  }
  return doi;
}

/**
 * Collect DOI candidates from ordered text sources (callers pass metadata
 * fields before page text so document-declared DOIs outrank cited ones).
 * Deduped case-insensitively (DOIs are case-insensitive), order preserved.
 */
export function extractDoiCandidates(sources: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of sources) {
    for (const match of text.matchAll(DOI_PATTERN)) {
      const doi = trimDoi(match[0]);
      if (doi.length < 8) continue; // "10.1234/" with an empty suffix
      const key = doi.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(doi);
    }
  }
  return out;
}

/** The best DOI candidate, or null when none was found. */
export function extractLikelyDoi(sources: string[]): string | null {
  return extractDoiCandidates(sources)[0] ?? null;
}
