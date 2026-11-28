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

/**
 * The label for a page: its chosen name; else its first heading; else
 * "Page N" / "Diagram N" from its default name.
 */
export function pageLabel(kind: PageKind, name: string, heading?: string | null): string {
  if (!hasDefaultName(name, kind)) return name;
  const fromHeading = heading ? nameFromText(heading) : null;
  if (fromHeading) return fromHeading;
  const n = defaultPageNumber(name, kind);
  return n === null ? pageKindNoun(kind) : `${pageKindNoun(kind)} ${n}`;
}

const headingCache = new Map<string, string | null>();
const HEADING_CACHE_MAX = 256;

/** The text of the first heading in a page's HTML, or null. Cached by content. */
export function firstHeadingInHtml(html: string): string | null {
  if (!html || !/<h[1-6][\s>]/i.test(html)) return null;
  const cached = headingCache.get(html);
  if (cached !== undefined) return cached;
  let text: string | null = null;
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    text = doc.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim() || null;
  }
  if (headingCache.size >= HEADING_CACHE_MAX) headingCache.clear();
  headingCache.set(html, text);
  return text;
}
