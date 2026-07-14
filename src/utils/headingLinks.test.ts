/**
 * The docushark:// heading-link grammar (JP-432 Pillar C): the id form and the
 * legacy positional form must both parse, round-trip through the authoring
 * helpers, and stay unambiguous (the `id:` discriminator vs plain digits).
 */

import { describe, it, expect } from 'vitest';
import {
  headingHrefById,
  headingHrefByIndex,
  isHeadingHref,
  parseHeadingHref,
} from './headingLinks';

describe('heading link grammar', () => {
  it('parses the legacy positional form', () => {
    expect(parseHeadingHref('docushark://heading/page-abc/3')).toEqual({
      pageId: 'page-abc',
      index: 3,
    });
  });

  it('parses the durable id form', () => {
    expect(parseHeadingHref('docushark://heading/page-abc/id:blk-x1_Y2-z3AB')).toEqual({
      pageId: 'page-abc',
      blockId: 'blk-x1_Y2-z3AB',
    });
  });

  it('round-trips through the authoring helpers', () => {
    expect(parseHeadingHref(headingHrefById('p1', 'blk-aaaa'))).toEqual({
      pageId: 'p1',
      blockId: 'blk-aaaa',
    });
    expect(parseHeadingHref(headingHrefByIndex('p1', 0))).toEqual({ pageId: 'p1', index: 0 });
  });

  it('rejects malformed hrefs', () => {
    for (const bad of [
      'docushark://heading/page-abc',
      'docushark://heading/page-abc/id:',
      'docushark://heading/page-abc/id:has space',
      'docushark://heading/page-abc/3x',
      'docushark://page/page-abc',
      'https://example.com',
    ]) {
      expect(parseHeadingHref(bad), bad).toBeNull();
      expect(isHeadingHref(bad), bad).toBe(false);
    }
  });

  it('isHeadingHref accepts both forms', () => {
    expect(isHeadingHref('docushark://heading/p/0')).toBe(true);
    expect(isHeadingHref('docushark://heading/p/id:blk-a')).toBe(true);
  });
});
