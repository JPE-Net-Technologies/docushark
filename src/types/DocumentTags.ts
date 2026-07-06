/**
 * Document tags (JP-388) — normalization + matching helpers.
 *
 * Tags are free-form document content (see `DiagramDocument.tags`): stored
 * case-preserving, matched and deduplicated case-insensitively. A leading `#`
 * is stripped on input so a tag typed as `#foo` equals `foo` — which keeps the
 * browser's `#tag` search syntax unambiguous (stored tags never start with a
 * `#`). Normalization runs on every WRITE seam (tag editor commit,
 * `setDocumentTags`), never on read — legacy bodies display as-is.
 */

export const MAX_TAGS_PER_DOC = 20;
export const MAX_TAG_LENGTH = 40;

/**
 * Normalize a tag list: trim → strip a leading `#` → drop empties → truncate
 * to MAX_TAG_LENGTH → case-insensitive dedupe keeping the first casing → cap
 * at MAX_TAGS_PER_DOC. Pure and idempotent; preserves first-seen order.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    let tag = raw.trim();
    while (tag.startsWith('#')) tag = tag.slice(1).trimStart();
    if (!tag) continue;
    tag = tag.slice(0, MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_DOC) break;
  }
  return out;
}

/** Order-sensitive equality (tags keep insertion order); absent ≡ empty. */
export function tagsEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((t, i) => t === right[i]);
}

/** Case-insensitive substring match against a document's tags. */
export function tagsMatch(tags: readonly string[] | undefined, needle: string): boolean {
  if (!tags || tags.length === 0) return false;
  const q = needle.toLowerCase();
  return tags.some((t) => t.toLowerCase().includes(q));
}

/**
 * Number of tag-color CSS variables (`--tag-hue-0` … `--tag-hue-{N-1}`)
 * defined for both themes in index.css.
 */
export const TAG_COLOR_COUNT = 8;

/**
 * Deterministic palette index for a tag: the same tag renders the same chip
 * color everywhere (case-insensitive), with no per-tag color registry to
 * store or sync. FNV-1a over the lowercased tag, mod the palette size.
 */
export function tagColorIndex(tag: string): number {
  const s = tag.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % TAG_COLOR_COUNT;
}
