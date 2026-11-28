/**
 * Page facts (DSK-260): kind, size, and where a page prints, counted in pages,
 * as the document's PDF settings place diagrams.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pdf = vi.hoisted(() => ({ settings: null as null | { diagramEmbed?: { enabled: boolean; position: string } } }));
vi.mock('../../store/persistenceStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/persistenceStore')>();
  return { ...actual, loadDocumentPdfSettings: () => pdf.settings };
});

import { useDocumentStore } from '../../store/documentStore';
import { usePageStore } from '../../store/pageStore';
import { usePendingPageDeletes } from '../../store/pendingPageDeleteStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useRichTextPagesStore } from '../../store/richTextPagesStore';
import { __resetPageFactsCache, factsLine, ordinal, pageFacts } from './pageFacts';

let empty = '';
let drawn = '';

beforeEach(() => {
  __resetPageFactsCache();
  pdf.settings = null;
  usePendingPageDeletes.setState({ pending: {} });
  usePersistenceStore.setState({ currentDocumentId: 'doc-1' });
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  const prose = useRichTextPagesStore.getState();
  prose.createPage('Prose', undefined, 'p1');
  prose.createPage('Prose p.2', undefined, 'p2');
  prose.createPage('Prose p.3', undefined, 'p3');
  prose.updatePageContent('p1', '<h1>Intro</h1><p>one two</p>');

  usePageStore.getState().reset();
  useDocumentStore.getState().clear();
  empty = usePageStore.getState().createPage('Canvas'); // the open page, nothing drawn
  drawn = usePageStore.getState().createPage('Canvas p.2');
  const { pages } = usePageStore.getState();
  usePageStore.setState({ pages: { ...pages, [drawn]: { ...pages[drawn]!, shapeOrder: ['s1', 's2'] } } });
});

describe('pageFacts', () => {
  it('describes a writing page: words, and its place among the pages that print', () => {
    expect(pageFacts('prose', 'p1')).toEqual({ kind: 'Writing page', size: '3 words', print: '1st of 3 in the PDF' });
    expect(pageFacts('prose', 'p2').print).toBe('2nd of 3 in the PDF');
  });

  it('says a diagram is not in the PDF while the export leaves diagrams out', () => {
    expect(pageFacts('canvas', drawn)).toEqual({ kind: 'Diagram', size: '2 shapes', print: 'Not in the PDF' });
  });

  it('places diagrams after the writing, skipping an empty one', () => {
    pdf.settings = { diagramEmbed: { enabled: true, position: 'after-content' } };
    expect(pageFacts('canvas', drawn).print).toBe('4th of 4 in the PDF');
    expect(pageFacts('canvas', empty).print).toBe('Not in the PDF while it’s empty');
    expect(pageFacts('prose', 'p1').print).toBe('1st of 4 in the PDF');
  });

  it('places diagrams before the writing', () => {
    pdf.settings = { diagramEmbed: { enabled: true, position: 'after-cover' } };
    expect(pageFacts('canvas', drawn).print).toBe('1st of 4 in the PDF');
    expect(pageFacts('prose', 'p1').print).toBe('2nd of 4 in the PDF');
  });

  it('leaves out a page waiting to be deleted', () => {
    usePendingPageDeletes.setState({ pending: { p1: { kind: 'prose', toastId: 't', wasActive: false } } });
    expect(pageFacts('prose', 'p2').print).toBe('1st of 2 in the PDF');
  });

  it('counts what the open diagram has now', () => {
    usePageStore.getState().setActivePage(empty);
    useDocumentStore.getState().addShape({
      id: 'r1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, rotation: 0, opacity: 1,
      locked: false, visible: true, fill: '#fff', stroke: '#000', strokeWidth: 1, cornerRadius: 0,
    } as never);
    expect(pageFacts('canvas', empty).size).toBe('1 shape');
  });

  it('reads as one line', () => {
    expect(factsLine(pageFacts('prose', 'p1'))).toBe('Writing page · 3 words · 1st of 3 in the PDF');
  });
});

describe('ordinal', () => {
  it('uses the right suffix, teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th',
    ]);
  });
});
