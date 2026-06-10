/**
 * Tests for CSL citation formatting (JP-89 slice 3).
 *
 * These exercise the real lazy-loaded citation-js engine + the vendored CSL
 * styles (no network — styles are bundled).
 */
import { describe, expect, it } from 'vitest';
import { CITATION_STYLES, formatBibliography, formatCitation, type CitationStyle } from './format';
import type { CSLItem } from '../../types/Citation';

const smith: CSLItem = {
  id: 'smith2020',
  type: 'article-journal',
  title: 'On the Behaviour of Things',
  author: [{ family: 'Smith', given: 'Jane' }],
  'container-title': 'Journal of Things',
  volume: '12',
  issue: '3',
  page: '45-67',
  issued: { 'date-parts': [[2020, 5, 1]] },
};

const doe: CSLItem = {
  id: 'doe2019',
  type: 'book',
  title: 'A Theory of Everything',
  author: [{ family: 'Doe', given: 'John' }],
  publisher: 'Academic Press',
  issued: { 'date-parts': [[2019]] },
};

const ALL_STYLES = CITATION_STYLES.map((s) => s.id);

describe('formatBibliography', () => {
  it('renders a non-empty bibliography in every supported style', async () => {
    for (const style of ALL_STYLES) {
      const html = await formatBibliography([smith, doe], style);
      expect(html, `style=${style}`).toContain('Smith');
      expect(html, `style=${style}`).toContain('Doe');
      expect(html, `style=${style}`).toContain('Behaviour of Things');
    }
  });

  it('re-renders differently when the style changes', async () => {
    const apa = await formatBibliography([smith], 'apa');
    const vancouver = await formatBibliography([smith], 'vancouver');
    const mla = await formatBibliography([smith], 'mla');
    expect(apa).not.toBe(vancouver);
    expect(apa).not.toBe(mla);
    // All still describe the same work.
    for (const out of [apa, vancouver, mla]) {
      expect(out).toContain('Smith');
    }
  });

  it('returns empty string for no items', async () => {
    expect(await formatBibliography([], 'apa')).toBe('');
  });
});

describe('formatCitation', () => {
  it('author-based styles name the author in-text', async () => {
    // APA, MLA, Chicago all key the in-text citation off the author name.
    const authorStyles: CitationStyle[] = ['apa', 'mla', 'chicago'];
    for (const style of authorStyles) {
      const cite = await formatCitation([smith], style, 'text');
      expect(cite, `style=${style}`).toContain('Smith');
    }
  });

  it('Vancouver renders a numeric in-text citation', async () => {
    // Vancouver is a numbered style — in-text is a reference number, not a name.
    const cite = await formatCitation([smith], 'vancouver', 'text');
    expect(cite).toMatch(/\d/);
    expect(cite).not.toContain('Smith');
  });

  it('author-date styles include the year in-text', async () => {
    // APA and Chicago author-date carry the year in-text; MLA (author-page)
    // and Vancouver (numeric) do not.
    for (const style of ['apa', 'chicago'] as CitationStyle[]) {
      const cite = await formatCitation([smith], style, 'text');
      expect(cite, `style=${style}`).toContain('2020');
    }
  });

  it('returns empty string for no items', async () => {
    expect(await formatCitation([], 'apa')).toBe('');
  });
});
