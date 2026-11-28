/**
 * What a page is called on screen (DSK-260).
 *
 * A page shows the name someone gave it. While its name is still the default
 * ("Prose p.2", "Canvas", or the older "Page 3"), it shows its first heading
 * instead, the way a browser tab shows the page's title, and "Page 2" or
 * "Diagram 2" while it has none.
 *
 * Display only. The stored name never changes, so older builds and MCP
 * clients see what they always saw, and the PDF prints no page names at all.
 */

import { nameFromText } from '../../services/documentNaming';
import { CANVAS_PAGE_BASE, PROSE_PAGE_BASE } from '../../store/pageNaming';

/** A writing page (prose) or a diagram (canvas). */
export type PageKind = 'prose' | 'canvas';

/** "Page" or "Diagram": what the app calls a page of each kind. */
export function pageKindNoun(kind: PageKind): string {
  return kind === 'prose' ? 'Page' : 'Diagram';
}

/**
 * The number in a default page name, or null when someone chose the name:
 * `Prose` → 1, `Prose p.3` → 3, and the older shared default `Page 4` → 4.
 */
export function defaultPageNumber(name: string, kind: PageKind): number | null {
  const base = kind === 'prose' ? PROSE_PAGE_BASE : CANVAS_PAGE_BASE;
  if (name === base) return 1;
  let suffix: string | null = null;
  if (name.startsWith(`${base} p.`)) suffix = name.slice(base.length + 3);
  else if (name.startsWith('Page ')) suffix = name.slice('Page '.length);
  if (suffix === null || !/^\d{1,6}$/.test(suffix)) return null;
  return Number(suffix);
}

/** Whether a page still has the name it was given by default. */
export function hasDefaultName(name: string, kind: PageKind): boolean {
  return name.trim() === '' || defaultPageNumber(name, kind) !== null;
}

/** What Duplicate appends to a page's stored name. */
const COPY_SUFFIX = ' (Copy)';

/**
 * The label for a page: its chosen name; else its first heading; else
 * "Page N" / "Diagram N" from its default name. A copy of a default-named
 * page reads as a copy of that label ("Diagram 2 (Copy)"), not as the
 * stored "Canvas p.2 (Copy)".
 */
export function pageLabel(kind: PageKind, name: string, heading?: string | null): string {
  if (name.endsWith(COPY_SUFFIX)) {
    const base = name.slice(0, -COPY_SUFFIX.length);
    if (base.trim() !== '' && (hasDefaultName(base, kind) || base.endsWith(COPY_SUFFIX))) {
      return `${pageLabel(kind, base, heading)}${COPY_SUFFIX}`;
    }
  }
  if (!hasDefaultName(name, kind)) return name;
  const fromHeading = heading ? nameFromText(heading) : null;
  if (fromHeading) return fromHeading;
  const n = defaultPageNumber(name, kind);
  return n === null ? pageKindNoun(kind) : `${pageKindNoun(kind)} ${n}`;
}

const headingCache = new Map<string, string | null>();
const HEADING_CACHE_MAX = 256;
const OPENING_HEADING = /<h([1-6])[\s>]/i;
/** How much markup to read when a heading never closes. */
const UNCLOSED_HEADING_CHARS = 2_000;

/**
 * The text of the first heading in a page's HTML, or null.
 *
 * Only that heading's markup is parsed and cached, never the whole page: the
 * page's HTML changes with every save, and a long page runs to hundreds of
 * kilobytes. Markup in the page's text is escaped, so the first `<h1>`…`<h6>`
 * in the HTML is the first heading in the page.
 */
export function firstHeadingInHtml(html: string): string | null {
  const opening = OPENING_HEADING.exec(html);
  if (!opening) return null;
  const closing = new RegExp(`</h${opening[1]}\\s*>`, 'ig');
  closing.lastIndex = opening.index;
  const end = closing.exec(html);
  const markup = html.slice(opening.index, end ? end.index + end[0].length : opening.index + UNCLOSED_HEADING_CHARS);
  const cached = headingCache.get(markup);
  if (cached !== undefined) return cached;
  let text: string | null = null;
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    text = doc.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim() || null;
  }
  if (headingCache.size >= HEADING_CACHE_MAX) headingCache.clear();
  headingCache.set(markup, text);
  return text;
}
