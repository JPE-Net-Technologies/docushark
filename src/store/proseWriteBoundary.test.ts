/**
 * Prose-projection write boundary (JP-198).
 *
 * `richTextStore` / `richTextPagesStore` hold a PROJECTION of prose content: the
 * editor (and, in collab, the Y.Doc fragment) is the source of truth; the store
 * mirrors it. To keep that single-source invariant **by construction, not just
 * by convention**, only an allowlisted set of modules may imperatively WRITE
 * prose content. Everyone else — metadata like the custom dictionary, future
 * injectors — must go through a dedicated method (e.g. `addDictionaryWord`) or
 * the CRDT bus (`mutateDocument` / `YjsDocument.appendProse`).
 *
 * Detection (modeled on `src/platform/importBoundary.test.ts`):
 *  - the precise imperative vector `useRichText{Store,PagesStore}.getState().<write>(`
 *    and `.setState(` — how an external writer bypasses the mirror; and
 *  - the bespoke method names `loadContent`/`loadPages`/`updatePageContent` in any
 *    form (incl. a variable holding `getState()`), since those names don't collide
 *    with editor commands.
 * `setContent`/`reset` via a variable-held `getState()` is the known residual gap
 * (those names collide with `editor.commands.setContent`); the inline `getState()`
 * form is still caught. The editors' own hook destructuring IS the sanctioned
 * mirror and is allowlisted regardless.
 *
 * If this fails: do NOT add your file to the allowlist to make it pass. Route the
 * write through the editor mirror, a load, or a purpose-built action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..');

/** Recursively collect non-test `.ts`/`.tsx` files under `dir`. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Imperative bypass: `useRichText*.getState().<write>(` or `useRichText*.setState(`. */
const IMPERATIVE_RE =
  /(?:useRichTextStore|useRichTextPagesStore)\s*\.\s*(?:getState\(\)\s*\.\s*(?:setContent|loadContent|reset|updatePageContent|loadPages)|setState)\s*\(/g;
/** Bespoke content-write names that can't collide with editor commands. */
const DISTINCTIVE_RE = /\.(?:loadContent|loadPages|updatePageContent)\s*\(/g;
const REFERENCES_PROSE_STORE = /useRichText(?:Store|PagesStore)/;

/**
 * Files permitted to imperatively write prose CONTENT, each with WHY. This is
 * the sanctioned mirror/load surface — keep it small.
 */
const ALLOWLIST = new Set<string>([
  'store/persistenceStore.ts', // document load + reset + page setState reset
  'ui/CollaborativeProseEditor.tsx', // collab editor onUpdate mirror
  'ui/TiptapEditor.tsx', // local editor onUpdate mirror
  'ui/DocumentEditorPanel.tsx', // page-switch mirror sync
  'ui/settings/DocumentsSettings.tsx', // restore / import load
  'ui/PDFExportDialog.tsx', // pre-export active-page sync (TODO: flush via editor instead)
]);

describe('prose-projection write boundary (JP-198)', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('smoke: found a representative number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('only allowlisted modules imperatively write prose content', () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      const source = readFileSync(file, 'utf-8');

      for (const m of source.matchAll(IMPERATIVE_RE)) {
        offenders.push({ file: rel, match: m[0] });
      }
      if (REFERENCES_PROSE_STORE.test(source)) {
        for (const m of source.matchAll(DISTINCTIVE_RE)) {
          offenders.push({ file: rel, match: m[0] });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('smoke: the allowlisted mirror/load files actually do write (regex works)', () => {
    const writers = [...ALLOWLIST].filter((rel) => {
      const source = readFileSync(resolve(SRC_ROOT, rel), 'utf-8');
      IMPERATIVE_RE.lastIndex = 0;
      DISTINCTIVE_RE.lastIndex = 0;
      return (
        IMPERATIVE_RE.test(source) ||
        (REFERENCES_PROSE_STORE.test(source) && DISTINCTIVE_RE.test(source))
      );
    });
    // At least the loaders + collab mirror should match; a near-empty result
    // means the detection regex silently stopped working.
    expect(writers.length).toBeGreaterThanOrEqual(3);
  });
});
