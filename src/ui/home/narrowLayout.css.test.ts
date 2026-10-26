/**
 * The Documents surface's narrow layout is CSS (DSK-196), and jsdom can't
 * evaluate media or container queries, so this pins the stylesheet contract
 * instead: in a narrow list the row's fixed tracks are gone (they left the
 * name 0px), and the widths and names the TSX uses for the same layout are the
 * ones the stylesheets use.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { COMPACT_WIDTH_QUERY } from '../layout/useMediaQuery';
import { DOCUMENTS_LIST_CONTAINER, LIST_ROWS_NARROW_MAX } from './documentsLayout';

function css(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

/** The first `<prelude> {…}` block (an at-rule), braces balanced. */
function block(source: string, prelude: string): string {
  const start = source.indexOf(`${prelude} {`);
  expect(start, `no ${prelude} block`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced media block');
}

/** The declarations of `selector {…}` inside a block (the selector list's last line). */
function rule(block: string, selector: string): string {
  const at = block.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return block.slice(block.indexOf('{', at) + 1, block.indexOf('}', at));
}

const NARROW_LIST = `@container ${DOCUMENTS_LIST_CONTAINER} (max-width: ${LIST_ROWS_NARROW_MAX}px)`;

describe('narrow Documents layout (DSK-196)', () => {
  const cardCss = css('src/ui/DocumentCard.css');
  const card = block(cardCss, NARROW_LIST);

  it('drops the list row’s fixed column cells, details toggle and panel', () => {
    expect(card).toMatch(/\.document-card--full \.document-card__cell,/);
    expect(card).toMatch(/\.document-card--full \.document-card__expand,/);
    expect(rule(card, '.document-card--full .document-card__details')).toMatch(/display:\s*none/);
  });

  it('moves the date and size onto the meta line', () => {
    expect(card).toMatch(/\.document-card--full \.document-card__date,/);
    expect(rule(card, '.document-card--full .document-card__size-inline')).toMatch(/display:\s*inline/);
  });

  it('frees the actions track that, with the cells, left the name 0px', () => {
    expect(rule(card, '.document-card--full .document-card__actions')).toMatch(/width:\s*auto/);
  });

  it('measures the list itself, so a sidebar beside a short list counts', () => {
    expect(rule(css('src/ui/home/DocumentsHome.css'), '.dh-content')).toMatch(
      new RegExp(`container:\\s*${DOCUMENTS_LIST_CONTAINER} / inline-size`),
    );
  });

  it('comes after every rule it overrides (a query block adds no specificity)', () => {
    const at = cardCss.indexOf(NARROW_LIST);
    for (const base of ['.document-card--full .document-card__date {', '.document-card__expand {', '.document-card__details {']) {
      expect(cardCss.indexOf(base), base).toBeLessThan(at);
    }
  });

  it('lays the grid out in two columns on a phone', () => {
    const home = block(css('src/ui/home/DocumentsHome.css'), `@media ${COMPACT_WIDTH_QUERY}`);
    expect(rule(home, '.dh-content .document-browser__section-body--grid')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fill, minmax\(150px, 1fr\)\)/,
    );
  });

  it('switches at the --bp-compact token', () => {
    expect(css('src/index.css')).toMatch(/--bp-compact:\s*640px/);
    expect(COMPACT_WIDTH_QUERY).toBe('(max-width: 640px)');
  });
});
