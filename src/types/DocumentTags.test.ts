/**
 * Document tags (JP-388) — normalization, matching, and deterministic colors.
 * `normalizeTags` runs on every write seam, so its invariants (idempotence,
 * dedupe, `#`-strip, caps) are load-bearing for the search syntax and the
 * relay round-trip.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_TAGS_PER_DOC,
  MAX_TAG_LENGTH,
  TAG_COLOR_COUNT,
  normalizeTags,
  tagsEqual,
  tagsMatch,
  tagColorIndex,
} from './DocumentTags';

describe('normalizeTags', () => {
  it('trims, drops empties, and preserves first-seen order', () => {
    expect(normalizeTags(['  alpha ', '', '  ', 'beta'])).toEqual(['alpha', 'beta']);
  });

  it('dedupes case-insensitively keeping the first casing', () => {
    expect(normalizeTags(['Research', 'research', 'RESEARCH', 'notes'])).toEqual([
      'Research',
      'notes',
    ]);
  });

  it('strips leading # so a typed "#foo" equals "foo" (search stays unambiguous)', () => {
    expect(normalizeTags(['#foo', '##bar', '# baz'])).toEqual(['foo', 'bar', 'baz']);
    // A stored tag never starts with '#'.
    for (const t of normalizeTags(['#x', 'y'])) {
      expect(t.startsWith('#')).toBe(false);
    }
  });

  it('caps tag length and count', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH + 20);
    expect(normalizeTags([long])[0]).toHaveLength(MAX_TAG_LENGTH);
    const many = Array.from({ length: MAX_TAGS_PER_DOC + 10 }, (_, i) => `tag-${i}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS_PER_DOC);
  });

  it('is idempotent', () => {
    const once = normalizeTags(['  #Alpha', 'beta', 'ALPHA ']);
    expect(normalizeTags(once)).toEqual(once);
  });
});

describe('tagsEqual', () => {
  it('is order-sensitive and treats absent as empty', () => {
    expect(tagsEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(tagsEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(tagsEqual(undefined, [])).toBe(true);
    expect(tagsEqual(undefined, ['a'])).toBe(false);
  });
});

describe('tagsMatch', () => {
  it('matches case-insensitive substrings', () => {
    expect(tagsMatch(['Research', 'notes'], 'sear')).toBe(true);
    expect(tagsMatch(['Research'], 'RESEARCH')).toBe(true);
    expect(tagsMatch(['Research'], 'zzz')).toBe(false);
  });

  it('empty needle matches any tagged doc, never an untagged one (bare "#")', () => {
    expect(tagsMatch(['a'], '')).toBe(true);
    expect(tagsMatch([], '')).toBe(false);
    expect(tagsMatch(undefined, '')).toBe(false);
  });
});

describe('tagColorIndex', () => {
  it('is stable, case-insensitive, and in palette range', () => {
    expect(tagColorIndex('Research')).toBe(tagColorIndex('research'));
    expect(tagColorIndex('alpha')).toBe(tagColorIndex('alpha'));
    for (const t of ['a', 'bb', 'research', 'ops', 'q3-planning']) {
      const i = tagColorIndex(t);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(TAG_COLOR_COUNT);
    }
  });
});
