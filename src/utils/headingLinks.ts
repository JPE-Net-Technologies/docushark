/**
 * The docushark:// heading-link grammar (JP-432 Pillar C).
 *
 * Two accepted forms:
 *  - **id form** (authored since Pillar C):
 *    `docushark://heading/<pageId>/id:<blockId>` — resolves via the heading's
 *    durable block id (the `id="blk-…"` attribute), so the link survives
 *    outline restructuring, section inserts, and text edits.
 *  - **legacy positional form**: `docushark://heading/<pageId>/<index>` — the
 *    0-based index over the page's `h1..h6` in DOM order. Accepted FOREVER
 *    (documents in the wild carry it — dropping it would break every existing
 *    link); the document migration rewrites resolvable ones to the id form.
 *
 * The `id:` discriminator keeps the two forms unambiguous (a legacy index is
 * always plain digits). This module is the single parser/author for the
 * grammar — shared by `useProseLinkClicks` (click navigation),
 * `InsertLinkDialog` (authoring), and `pdfExportUtils` (PDF-internal links).
 */

export interface HeadingHref {
  pageId: string;
  /** Durable block id (id form). */
  blockId?: string;
  /** Positional heading index (legacy form). */
  index?: number;
}

const HEADING_HREF_RE = /^docushark:\/\/heading\/([^/]+)\/(?:id:([A-Za-z0-9_-]+)|(\d+))$/;

/** Parse either grammar form; `null` for anything else. */
export function parseHeadingHref(href: string): HeadingHref | null {
  const m = href.match(HEADING_HREF_RE);
  if (!m) return null;
  const pageId = m[1]!;
  if (m[2]) return { pageId, blockId: m[2] };
  return { pageId, index: parseInt(m[3]!, 10) };
}

/** Author an id-form heading href (the durable form — preferred). */
export function headingHrefById(pageId: string, blockId: string): string {
  return `docushark://heading/${pageId}/id:${blockId}`;
}

/** Author a legacy positional href (only when the target has no id yet). */
export function headingHrefByIndex(pageId: string, index: number): string {
  return `docushark://heading/${pageId}/${index}`;
}

/** True when `href` is either form of the heading grammar. */
export function isHeadingHref(href: string): boolean {
  return HEADING_HREF_RE.test(href);
}
