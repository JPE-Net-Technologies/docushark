import { describe, it, expect } from 'vitest';
import {
  MAX_VIEW_RECORDS,
  viewKey,
  upsertRecord,
  toggleBookmark,
  renameBookmark,
  removeBookmark,
  reconcileRecord,
  type FileViewRecord,
  type PdfBookmark,
} from './fileViewState';

const NOW = 1_000_000;

function record(overrides: Partial<FileViewRecord> = {}): FileViewRecord {
  return {
    hash: 'hash-a',
    lastPage: 5,
    zoomMode: 'page-width',
    bookmarks: [],
    updatedAt: NOW,
    ...overrides,
  };
}

describe('viewKey', () => {
  it('composes docId and shapeId', () => {
    expect(viewKey('doc1', 'shape9')).toBe('doc1:shape9');
  });
});

describe('upsertRecord', () => {
  it('creates a record with defaults + patch', () => {
    const out = upsertRecord({}, 'k', { hash: 'h', lastPage: 3 }, NOW);
    expect(out['k']).toEqual({
      hash: 'h',
      lastPage: 3,
      zoomMode: 'page-width',
      bookmarks: [],
      updatedAt: NOW,
    });
  });

  it('merges into an existing record and stamps updatedAt', () => {
    const initial = { k: record({ lastPage: 2, updatedAt: 1 }) };
    const out = upsertRecord(initial, 'k', { lastPage: 7 }, NOW);
    expect(out['k']!.lastPage).toBe(7);
    expect(out['k']!.hash).toBe('hash-a');
    expect(out['k']!.updatedAt).toBe(NOW);
    // Input untouched (pure)
    expect(initial['k']!.lastPage).toBe(2);
  });

  it('evicts oldest records over the cap', () => {
    let records: Record<string, FileViewRecord> = {};
    for (let i = 0; i < MAX_VIEW_RECORDS; i++) {
      records = upsertRecord(records, `k${i}`, { hash: 'h' }, i);
    }
    const out = upsertRecord(records, 'new', { hash: 'h' }, NOW);
    expect(Object.keys(out)).toHaveLength(MAX_VIEW_RECORDS);
    expect(out['new']).toBeDefined();
    expect(out['k0']).toBeUndefined(); // oldest evicted
    expect(out['k1']).toBeDefined();
  });

  it('prefers evicting bookmark-less records over bookmarked ones', () => {
    const bookmark: PdfBookmark = { page: 1, createdAt: 0 };
    let records: Record<string, FileViewRecord> = {};
    // Oldest record is bookmarked; the next-oldest is not.
    records = upsertRecord(records, 'bookmarked-old', { hash: 'h', bookmarks: [bookmark] }, 0);
    for (let i = 1; i < MAX_VIEW_RECORDS; i++) {
      records = upsertRecord(records, `plain${i}`, { hash: 'h' }, i);
    }
    const out = upsertRecord(records, 'new', { hash: 'h' }, NOW);
    expect(out['bookmarked-old']).toBeDefined(); // survived despite being oldest
    expect(out['plain1']).toBeUndefined(); // oldest bookmark-less evicted instead
  });

  it('never evicts the just-updated key', () => {
    let records: Record<string, FileViewRecord> = {};
    for (let i = 0; i < MAX_VIEW_RECORDS + 5; i++) {
      records = upsertRecord(records, `k${i}`, { hash: 'h' }, i);
    }
    // The final key has the newest stamp, but even updating with an old-looking
    // timestamp must keep it.
    const out = upsertRecord(records, 'target', { hash: 'h' }, 0);
    expect(out['target']).toBeDefined();
    expect(Object.keys(out)).toHaveLength(MAX_VIEW_RECORDS);
  });
});

describe('toggleBookmark', () => {
  it('adds when absent, sorted by page', () => {
    const out = toggleBookmark([{ page: 8, createdAt: 1 }], 3, NOW);
    expect(out.map((b) => b.page)).toEqual([3, 8]);
    expect(out[0]!.createdAt).toBe(NOW);
  });

  it('removes when present', () => {
    const out = toggleBookmark(
      [
        { page: 3, createdAt: 1 },
        { page: 8, createdAt: 2 },
      ],
      3,
      NOW,
    );
    expect(out.map((b) => b.page)).toEqual([8]);
  });

  it('round-trips to the original set', () => {
    const start: PdfBookmark[] = [{ page: 2, createdAt: 1 }];
    const out = toggleBookmark(toggleBookmark(start, 5, NOW), 5, NOW);
    expect(out.map((b) => b.page)).toEqual([2]);
  });
});

describe('renameBookmark', () => {
  const marks: PdfBookmark[] = [
    { page: 2, createdAt: 1 },
    { page: 5, createdAt: 2, label: 'Results' },
  ];

  it('sets a trimmed label', () => {
    const out = renameBookmark(marks, 2, '  Methods  ');
    expect(out[0]!.label).toBe('Methods');
    expect(out[1]!.label).toBe('Results');
  });

  it('clears the label on empty input', () => {
    const out = renameBookmark(marks, 5, '   ');
    expect(out[1]!.label).toBeUndefined();
    expect('label' in out[1]!).toBe(false);
  });

  it('ignores pages without a bookmark', () => {
    expect(renameBookmark(marks, 9, 'x')).toEqual(marks);
  });
});

describe('removeBookmark', () => {
  it('removes only the targeted page', () => {
    const out = removeBookmark(
      [
        { page: 2, createdAt: 1 },
        { page: 5, createdAt: 2 },
      ],
      2,
    );
    expect(out.map((b) => b.page)).toEqual([5]);
  });
});

describe('reconcileRecord', () => {
  it('returns the same reference when hash matches and lastPage is in range', () => {
    const rec = record({ lastPage: 5 });
    expect(reconcileRecord(rec, 'hash-a', 10)).toBe(rec);
  });

  it('clamps a corrupt lastPage even without a replacement', () => {
    const rec = record({ lastPage: 40 });
    const out = reconcileRecord(rec, 'hash-a', 10);
    expect(out.lastPage).toBe(10);
    expect(out.hash).toBe('hash-a');
  });

  it('on replacement: rewrites hash, clamps lastPage, prunes out-of-range bookmarks', () => {
    const rec = record({
      lastPage: 11,
      bookmarks: [
        { page: 2, createdAt: 1, label: 'Intro' },
        { page: 12, createdAt: 2 },
      ],
    });
    const out = reconcileRecord(rec, 'hash-b', 6);
    expect(out.hash).toBe('hash-b');
    expect(out.lastPage).toBe(6);
    expect(out.bookmarks.map((b) => b.page)).toEqual([2]);
    expect(out.bookmarks[0]!.label).toBe('Intro'); // in-range bookmarks keep labels
  });

  it('on replacement with everything in range: keeps page and bookmarks', () => {
    const rec = record({ lastPage: 3, bookmarks: [{ page: 2, createdAt: 1 }] });
    const out = reconcileRecord(rec, 'hash-b', 20);
    expect(out.hash).toBe('hash-b');
    expect(out.lastPage).toBe(3);
    expect(out.bookmarks).toHaveLength(1);
  });

  it('handles a degenerate page count', () => {
    const rec = record({ lastPage: 5, bookmarks: [{ page: 3, createdAt: 1 }] });
    const out = reconcileRecord(rec, 'hash-b', 0);
    expect(out.lastPage).toBe(1);
    expect(out.bookmarks).toHaveLength(0);
  });
});
