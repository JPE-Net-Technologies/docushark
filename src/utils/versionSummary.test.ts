import { describe, it, expect } from 'vitest';
import {
  countWordsInHtml,
  summarizeDocument,
  diffVersionSummaries,
  groupPointsByDay,
} from './versionSummary';
import type { DiagramDocument, Page } from '../types/Document';
import type { RichTextPage } from '../store/richTextPagesStore';
import type { RelayRecoveryPoint } from '../api/relayClient';

function makePage(id: string, name: string, shapeIds: string[]): Page {
  return {
    id,
    name,
    shapes: Object.fromEntries(
      shapeIds.map((s) => [s, { id: s } as unknown as Page['shapes'][string]]),
    ),
    shapeOrder: shapeIds,
    createdAt: 1,
    modifiedAt: 2,
  };
}

function makeProsePage(id: string, name: string, content: string, order: number): RichTextPage {
  return { id, name, content, order, createdAt: 1, modifiedAt: 2 };
}

function makeDoc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    id: 'doc-1',
    name: 'Doc',
    pages: { p1: makePage('p1', 'Canvas 1', ['s1', 's2']) },
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 1,
    modifiedAt: 2,
    version: 2,
    ...overrides,
  };
}

describe('countWordsInHtml', () => {
  it('counts words across tags and entities', () => {
    expect(countWordsInHtml('<p>Hello <b>brave</b> world</p>')).toBe(3);
    expect(countWordsInHtml('<p>one&nbsp;two</p>')).toBe(2);
    expect(countWordsInHtml('')).toBe(0);
    expect(countWordsInHtml('<p></p>')).toBe(0);
  });
});

describe('summarizeDocument', () => {
  it('summarizes canvas and prose pages in order with totals', () => {
    const doc = makeDoc({
      pages: {
        p1: makePage('p1', 'Flow', ['s1', 's2']),
        p2: makePage('p2', 'Arch', ['s3']),
      },
      pageOrder: ['p2', 'p1'],
      richTextPages: {
        pages: {
          r1: makeProsePage('r1', 'Notes', '<p>alpha beta gamma</p>', 0),
        },
        pageOrder: ['r1'],
        activePageId: 'r1',
      },
    });
    const s = summarizeDocument(doc);
    expect(s.canvasPages.map((p) => p.name)).toEqual(['Arch', 'Flow']);
    expect(s.canvasPages.map((p) => p.shapeCount)).toEqual([1, 2]);
    expect(s.prosePages).toEqual([{ id: 'r1', name: 'Notes', wordCount: 3 }]);
    expect(s.totalShapes).toBe(3);
    expect(s.totalWords).toBe(3);
  });

  it('tolerates missing richTextPages and dangling page-order ids', () => {
    const doc = makeDoc({ pageOrder: ['p1', 'ghost'] });
    const s = summarizeDocument(doc);
    expect(s.canvasPages).toHaveLength(1);
    expect(s.prosePages).toEqual([]);
    expect(s.totalWords).toBe(0);
  });
});

describe('diffVersionSummaries', () => {
  it('reports pages unique to each side and count deltas', () => {
    const current = summarizeDocument(
      makeDoc({
        pages: {
          p1: makePage('p1', 'Kept', ['s1', 's2', 's3']),
          p2: makePage('p2', 'New page', ['s4']),
        },
        pageOrder: ['p1', 'p2'],
      }),
    );
    const version = summarizeDocument(
      makeDoc({
        pages: {
          p1: makePage('p1', 'Kept', ['s1']),
          p9: makePage('p9', 'Old page', []),
        },
        pageOrder: ['p1', 'p9'],
      }),
    );
    const d = diffVersionSummaries(current, version);
    expect(d.pagesOnlyInVersion).toEqual(['Old page']);
    expect(d.pagesOnlyInCurrent).toEqual(['New page']);
    expect(d.shapeDelta).toBe(1 - 4);
    expect(d.wordDelta).toBe(0);
  });
});

describe('groupPointsByDay', () => {
  const point = (id: string, createdAt: number): RelayRecoveryPoint => ({
    id,
    createdAt,
    serverVersion: 1,
    sizeBytes: 10,
  });

  it('labels today/yesterday and groups older points by date', () => {
    const now = new Date(2026, 6, 3, 15, 0, 0).getTime();
    const today = new Date(2026, 6, 3, 9, 30).getTime();
    const yesterday = new Date(2026, 6, 2, 22, 0).getTime();
    const older = new Date(2026, 5, 20, 12, 0).getTime();
    const groups = groupPointsByDay(
      [point('a', today), point('b', yesterday), point('c', yesterday), point('d', older)],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      new Date(older).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    ]);
    expect(groups[1]?.points.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('returns no groups for no points', () => {
    expect(groupPointsByDay([], Date.now())).toEqual([]);
  });
});
