import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { READING_WIDTHS } from './layout/types';

/**
 * JP-484. Two content-flow contracts that are invisible in code review and
 * silently regress if someone tidies the CSS.
 *
 * jsdom performs no layout, so these assert the declarations rather than the
 * resulting geometry (which was measured live in the browser instead).
 */

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `selector ${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('prose table anti-cramping', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/ui/TiptapEditor.css'), 'utf8');
  const colRule = ruleBody(css, '.tiptap-editor .ProseMirror table colgroup col');

  it('floors the column, which is the only lever `table-layout: fixed` reads', () => {
    // Under fixed layout the browser sizes the table from the column
    // definitions alone — a floor on `td`/`th` lets columns shrink anyway.
    expect(colRule).toMatch(/min-width:\s*var\(--table-min-col\)/);
    expect(css).toMatch(/--table-min-col:\s*[\d.]+rem/);
  });

  it('keeps `!important`, without which the rule is inert', () => {
    // Tiptap writes `min-width: 25px` as an INLINE style on every unsized
    // <col>, and inline beats any selector specificity. Those are exactly the
    // columns that crush, so dropping `!important` silently restores the bug
    // while the rule still appears to be doing something.
    expect(colRule).toMatch(/min-width:[^;]*!important/);
  });

  it('leaves the load-bearing table geometry alone', () => {
    // `width: 100%` + `table-layout: fixed` is required for posAtCoords to tell
    // laterally-adjacent cells apart; a `max-content` width broke lateral
    // multi-cell selection.
    const tableRule = ruleBody(css, '.tiptap-editor .ProseMirror table');
    expect(tableRule).toMatch(/table-layout:\s*fixed/);
    expect(tableRule).toMatch(/width:\s*100%/);
  });

  it('keeps the wrapper as the scroll container', () => {
    expect(ruleBody(css, '.tiptap-editor .ProseMirror .tableWrapper')).toMatch(/overflow-x:\s*auto/);
  });
});

describe('reading measure', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/ui/DocumentEditorPanel.css'), 'utf8');
  const readingRule = ruleBody(
    css,
    '.document-editor-panel.fullscreen .document-editor-panel-content,\n.document-editor-panel.reading .document-editor-panel-content'
  );

  it('never lets the column exceed its pane', () => {
    // The previous `clamp(36rem, 60vw, 52rem)` put a 576px *floor* on a
    // max-width, so any pane narrower than that overflowed and was clipped.
    expect(readingRule).toMatch(/max-width:\s*min\(100%,\s*var\(--reading-measure\)\)/);
  });

  it('measures the pane, not the viewport', () => {
    // `vw` resolves against the window, so the same declaration meant different
    // things in a full-width region and a split one.
    expect(readingRule).not.toMatch(/\dvw/);
  });

  it('declares a measure for every named reading width', () => {
    expect(css).toMatch(/\.document-editor-panel\s*\{[^}]*--reading-measure:/);
    for (const width of READING_WIDTHS) {
      if (width === 'normal') continue; // the base declaration is the default
      expect(css).toMatch(
        new RegExp(`\\[data-reading-width=['"]${width}['"]\\][^{]*\\{[^}]*--reading-measure:`)
      );
    }
  });
});

describe('readingWidth preference', () => {
  beforeEach(() => {
    useUIPreferencesStore.setState((s) => ({ layout: { ...s.layout, readingWidth: 'normal' } }));
  });

  it('defaults to normal', () => {
    expect(useUIPreferencesStore.getState().layout.readingWidth).toBe('normal');
  });

  it('round-trips every named width without disturbing the rest of the slice', () => {
    const before = useUIPreferencesStore.getState().layout;
    for (const width of READING_WIDTHS) {
      useUIPreferencesStore.getState().setReadingWidth(width);
      const after = useUIPreferencesStore.getState().layout;
      expect(after.readingWidth).toBe(width);
      expect(after.defaultMode).toBe(before.defaultMode);
      expect(after.customChrome).toBe(before.customChrome);
      expect(after.modeOverrides).toEqual(before.modeOverrides);
    }
  });
});
