import { describe, it, expect } from 'vitest';
import { extractDoiCandidates, extractLikelyDoi } from './pdfDoiExtract';

describe('extractDoiCandidates', () => {
  it('finds a plain DOI in page text', () => {
    expect(
      extractLikelyDoi(['This article: doi 10.1038/s41586-020-2649-2 published in Nature.']),
    ).toBe('10.1038/s41586-020-2649-2');
  });

  it('trims sentence punctuation', () => {
    expect(extractLikelyDoi(['See https://doi.org/10.1145/3517349.3520266.'])).toBe(
      '10.1145/3517349.3520266',
    );
    expect(extractLikelyDoi(['(doi: 10.1109/5.771073),'])).toBe('10.1109/5.771073');
  });

  it('keeps balanced parentheses that are part of the DOI', () => {
    expect(extractLikelyDoi(['ref 10.1016/S0140-6736(20)30183-5 here'])).toBe(
      '10.1016/S0140-6736(20)30183-5',
    );
  });

  it('trims an unbalanced closing paren from surrounding prose', () => {
    expect(extractLikelyDoi(['(see 10.1002/andp.19053221004)'])).toBe(
      '10.1002/andp.19053221004',
    );
  });

  it('ranks earlier sources first and dedupes case-insensitively', () => {
    const candidates = extractDoiCandidates([
      'Metadata DOI: 10.5555/META',
      'Body cites 10.5555/meta and also 10.1234/other-work.1',
    ]);
    expect(candidates).toEqual(['10.5555/META', '10.1234/other-work.1']);
  });

  it('ignores non-DOI decimals and empty suffixes', () => {
    expect(extractLikelyDoi(['Section 10.2 covers results; ratio was 10.5/12'])).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(extractLikelyDoi(['no identifiers here'])).toBeNull();
    expect(extractDoiCandidates([])).toEqual([]);
  });
});
