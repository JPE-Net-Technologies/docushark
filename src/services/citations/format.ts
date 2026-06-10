/**
 * CSL citation formatting (JP-89 slice 3).
 *
 * Renders CSL-JSON {@link CSLItem}s into a bibliography block and inline
 * citation strings, in any of the supported styles. Backed by `@citation-js`
 * (citeproc under the hood), **lazy-loaded** so the heavy library + the
 * vendored CSL XML land in a code-split chunk, never the core PWA bundle.
 *
 * APA / Vancouver / Harvard ship with `@citation-js/plugin-csl`; MLA + Chicago
 * are vendored CSL files registered on first use (see `./styles/NOTICE.md` for
 * their CC BY-SA 3.0 attribution).
 */

import type { CSLItem, CitationStyle } from '../../types/Citation';
// Vendored CSL XML (CC BY-SA 3.0 — see ./styles/NOTICE.md). `?raw` keeps these
// as strings in this module's lazy chunk.
import mlaCsl from './styles/modern-language-association.csl?raw';
import chicagoCsl from './styles/chicago-author-date.csl?raw';

// `CitationStyle` + `CITATION_STYLES` are owned by the model (`types/Citation.ts`)
// so light UI can use them without importing this heavy service (citation-js +
// vendored CSL XML). Re-exported here for callers that import from the formatter.
export type { CitationStyle };
export { CITATION_STYLES } from '../../types/Citation';

const DEFAULT_LOCALE = 'en-US';

/** citation-js template name for each style (built-in or vendored). */
const TEMPLATE_BY_STYLE: Record<CitationStyle, string> = {
  apa: 'apa',
  mla: 'mla',
  chicago: 'chicago',
  vancouver: 'vancouver',
};

/** Vendored styles to register (built-ins are already present). */
const VENDORED_TEMPLATES: ReadonlyArray<{ name: string; xml: string }> = [
  { name: 'mla', xml: mlaCsl },
  { name: 'chicago', xml: chicagoCsl },
];

type CiteModule = typeof import('@citation-js/core');

/**
 * Lazy-load citation-js + the CSL plugin and register the vendored templates
 * exactly once. Cached so repeated formatting reuses the same engine.
 */
let citePromise: Promise<CiteModule> | null = null;
function ensureCite(): Promise<CiteModule> {
  if (!citePromise) {
    citePromise = (async () => {
      const core = await import('@citation-js/core');
      await import('@citation-js/plugin-csl');
      const config = core.plugins.config.get('@csl');
      for (const { name, xml } of VENDORED_TEMPLATES) {
        if (!config.templates.has(name)) {
          config.templates.add(name, xml);
        }
      }
      return core;
    })();
  }
  return citePromise;
}

/**
 * Render a bibliography (reference list) for `items` in `style`, as HTML.
 * Returns an empty string for no items, or if formatting fails (logged) — a
 * malformed reference must never crash the editor/bibliography node.
 */
export async function formatBibliography(
  items: CSLItem[],
  style: CitationStyle,
): Promise<string> {
  if (items.length === 0) return '';
  try {
    const { Cite } = await ensureCite();
    const cite = new Cite(items);
    return cite.format('bibliography', {
      format: 'html',
      template: TEMPLATE_BY_STYLE[style],
      lang: DEFAULT_LOCALE,
    });
  } catch (err) {
    console.warn('[citations] bibliography formatting failed:', err);
    return '';
  }
}

/**
 * Render the inline citation string for `items` in `style` (e.g. `(Smith, 2020)`).
 * `format` selects HTML (default) or plain text. Returns `''` on failure (logged).
 */
export async function formatCitation(
  items: CSLItem[],
  style: CitationStyle,
  format: 'html' | 'text' = 'html',
): Promise<string> {
  if (items.length === 0) return '';
  try {
    const { Cite } = await ensureCite();
    const cite = new Cite(items);
    return cite.format('citation', {
      format,
      template: TEMPLATE_BY_STYLE[style],
      lang: DEFAULT_LOCALE,
    });
  } catch (err) {
    console.warn('[citations] citation formatting failed:', err);
    return '';
  }
}

/** Test-only: reset the cached engine so a fresh load can be exercised. */
export function __resetCiteCacheForTests(): void {
  citePromise = null;
}
