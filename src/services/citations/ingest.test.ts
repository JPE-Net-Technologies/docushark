/**
 * Tests for reference ingest (JP-89 slice 2).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  detectFormat,
  normalizeDoi,
  normalizeItem,
  parseReferences,
  resolveDoi,
} from './ingest';

/** Minimal Response-like stub for the injected fetch. */
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('detectFormat', () => {
  it('detects csl-json (array or object)', () => {
    expect(detectFormat('[{"id":"a"}]')).toBe('csl-json');
    expect(detectFormat('  {"id":"a"}')).toBe('csl-json');
  });
  it('detects bibtex', () => {
    expect(detectFormat('@article{key, title={X}}')).toBe('bibtex');
    expect(detectFormat('@book{ k ,')).toBe('bibtex');
  });
  it('returns null for unrecognized / empty', () => {
    expect(detectFormat('just some prose')).toBeNull();
    expect(detectFormat('   ')).toBeNull();
  });
});

describe('normalizeItem', () => {
  it('guarantees id and type', () => {
    expect(normalizeItem({ title: 'X' }, 'fb')).toEqual({ title: 'X', id: 'fb', type: 'document' });
    expect(normalizeItem({ id: 'real', type: 'book' }, 'fb')?.id).toBe('real');
  });
  it('rejects non-objects', () => {
    expect(normalizeItem('x', 'fb')).toBeNull();
    expect(normalizeItem(['a'], 'fb')).toBeNull();
    expect(normalizeItem(null, 'fb')).toBeNull();
  });
});

describe('parseReferences — CSL-JSON', () => {
  it('parses an array of items', async () => {
    const { items, report } = await parseReferences('[{"id":"a","type":"book"},{"id":"b","type":"article-journal"}]');
    expect(report.source).toBe('csl-json');
    expect(report.count).toBe(2);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('parses a single object', async () => {
    const { items } = await parseReferences('{"id":"single","type":"webpage"}', 'csl-json');
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('single');
  });
  it('reports invalid JSON without throwing', async () => {
    const { items, report } = await parseReferences('{not json', 'csl-json');
    expect(items).toEqual([]);
    expect(report.errors[0]).toContain('Invalid JSON');
  });
  it('skips non-object entries with a warning', async () => {
    const { items, report } = await parseReferences('[{"id":"a"}, 42]', 'csl-json');
    expect(items).toHaveLength(1);
    expect(report.warnings.length).toBe(1);
  });
});

describe('parseReferences — BibTeX (lazy citation-js)', () => {
  it('parses a journal article into CSL-JSON', async () => {
    const bibtex = `@article{smith2020,
      title = {On Things},
      author = {Smith, Jane and Doe, John},
      journal = {Journal of Things},
      year = {2020}
    }`;
    const { items, report } = await parseReferences(bibtex);
    expect(report.source).toBe('bibtex');
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('On Things');
    expect(item.type).toBe('article-journal');
    expect(item.author?.[0]?.family).toBe('Smith');
  });
  it('handles malformed BibTeX gracefully (no throw, empty + reported)', async () => {
    const { items, report } = await parseReferences('@', 'bibtex');
    expect(items).toEqual([]);
    expect(report.source).toBe('bibtex');
    expect(report.errors.length + report.warnings.length).toBeGreaterThan(0);
  });
});

describe('normalizeDoi', () => {
  it('strips common prefixes', () => {
    expect(normalizeDoi('https://doi.org/10.1/abc')).toBe('10.1/abc');
    expect(normalizeDoi('doi:10.1/abc')).toBe('10.1/abc');
    expect(normalizeDoi('  10.1/abc  ')).toBe('10.1/abc');
  });
});

describe('resolveDoi (injected fetch)', () => {
  const csl = { DOI: '10.1000/xyz', type: 'article-journal', title: 'Resolved' };

  it('resolves a DOI to a CSL item', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(csl));
    const { items, report } = await resolveDoi('10.1000/xyz', { fetch: fetchMock as unknown as typeof fetch });
    expect(report.source).toBe('doi');
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Resolved');
    // id keyed off the DOI when the payload has none.
    expect(items[0]?.id).toBe('10.1000/xyz');
    // requested CSL-JSON via content negotiation against doi.org.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://doi.org/10.1000/xyz');
    expect(init?.headers).toMatchObject({
      Accept: 'application/vnd.citationstyles.csl+json',
    });
  });

  it('accepts a full doi.org URL input', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(csl));
    await resolveDoi('https://doi.org/10.1000/xyz', { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://doi.org/10.1000/xyz');
  });

  it('rejects a malformed DOI before fetching', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(csl));
    const { items, report } = await resolveDoi('not-a-doi', { fetch: fetchMock as unknown as typeof fetch });
    expect(items).toEqual([]);
    expect(report.errors[0]).toContain('Not a valid DOI');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a 404 as "not found"', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, { status: 404 }));
    const { report } = await resolveDoi('10.1000/missing', { fetch: fetchMock as unknown as typeof fetch });
    expect(report.errors[0]).toContain('DOI not found');
  });

  it('reports a network failure without throwing', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });
    const { report } = await resolveDoi('10.1000/xyz', { fetch: fetchMock as unknown as typeof fetch });
    expect(report.errors[0]).toContain('DOI lookup failed');
    expect(report.errors[0]).toContain('offline');
  });
});
