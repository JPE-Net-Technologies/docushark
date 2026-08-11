/**
 * JP-475 — pageMirrorEquals must see every PageMirrorMeta field: it is the
 * ONLY field-enumerating site on the collab page-list path, so a field it
 * misses syncs on first write and then silently never re-syncs.
 */
import { describe, it, expect } from 'vitest';

import { pageMirrorEquals, type PageMirrorMeta } from './PageMirror';

const base: PageMirrorMeta = {
  provider: 'notion',
  externalId: 'ext-1',
  url: 'https://www.notion.so/x',
  iconEmoji: '📄',
  version: 'v1',
  syncedAt: 100,
};

describe('pageMirrorEquals', () => {
  it('is reflexive and handles undefined sides', () => {
    expect(pageMirrorEquals(base, { ...base })).toBe(true);
    expect(pageMirrorEquals(undefined, undefined)).toBe(true);
    expect(pageMirrorEquals(base, undefined)).toBe(false);
  });

  it('differs on every field, parentExternalId included', () => {
    const variants: Partial<PageMirrorMeta>[] = [
      { provider: 'confluence' },
      { externalId: 'ext-2' },
      { url: 'https://www.notion.so/y' },
      { iconEmoji: '🗂️' },
      { version: 'v2' },
      { syncedAt: 101 },
      { parentExternalId: 'ext-parent' },
    ];
    for (const delta of variants) {
      expect(pageMirrorEquals(base, { ...base, ...delta })).toBe(false);
    }
    expect(
      pageMirrorEquals({ ...base, parentExternalId: 'p1' }, { ...base, parentExternalId: 'p2' }),
    ).toBe(false);
    expect(
      pageMirrorEquals({ ...base, parentExternalId: 'p1' }, { ...base, parentExternalId: 'p1' }),
    ).toBe(true);
  });
});
