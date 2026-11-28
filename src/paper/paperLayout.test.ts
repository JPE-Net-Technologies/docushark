/**
 * Paper Mode's layout helpers (DSK-48): the options, which breaks fall in the
 * page being edited, their footers, and fitting the sheets on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DEFAULT_PDF_OPTIONS, type PDFExportOptions } from '../types/PDFExport';
import type { PdfLayout } from '../utils/pdfExport/paginate';
import {
  PAPER_BAND_PX,
  firstChangedBlock,
  fitPages,
  footerText,
  paperCssVariables,
  paperGeometry,
  paperOptions,
  paperPagesFor,
  printedPageNumber,
  prosePageSpan,
  type PaperGeometry,
} from './paperLayout';

const base: PDFExportOptions = { ...DEFAULT_PDF_OPTIONS, showPageNumbers: true, pageNumberFormat: 'x-of-y' };
const withCover: PDFExportOptions = { ...base, coverPage: { ...base.coverPage, enabled: true } };

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});
const docOf = (html: string) => {
  editor = new Editor({ extensions: [StarterKit], content: html });
  return editor.state.doc;
};

describe('paperOptions', () => {
  it("lays out with the document's page setup and without embedded diagrams", () => {
    const options = paperOptions(
      { ...base, diagramEmbed: { enabled: true, position: 'before-content', scale: 1, useThemeBackground: false } },
      { size: 'letter', orientation: 'landscape', margins: { top: 10, right: 11, bottom: 12, left: 13 } }
    );
    expect(options.pageSize).toBe('letter');
    expect(options.orientation).toBe('landscape');
    expect(options.margins).toEqual({ top: 10, right: 11, bottom: 12, left: 13 });
    expect(options.diagramEmbed?.enabled).toBe(false);
    expect(options.showPageNumbers).toBe(true);
  });
});

describe('firstChangedBlock', () => {
  it('finds the first top-level block that is a different node', () => {
    const before = docOf('<p>One</p><p>Two</p><p>Three</p>');
    editor!.commands.insertContentAt(before.child(0).nodeSize + 1, 'X');
    const after = editor!.state.doc;
    expect(firstChangedBlock(before, after)).toBe(1);
    expect(firstChangedBlock(after, after)).toBe(3);
  });
});

describe('page numbers', () => {
  const layout: PdfLayout = { pages: 4, contentsPages: 2, breaks: [], starts: [] };

  it('numbers content pages after the contents, the cover first', () => {
    expect(printedPageNumber(1, layout, base)).toBe(3);
    expect(printedPageNumber(1, layout, withCover)).toBe(1);
    expect(printedPageNumber(2, layout, withCover)).toBe(4);
  });

  it('prints the footer the export prints', () => {
    expect(footerText(3, 6, base)).toBe('Page 3 of 6');
    expect(footerText(3, 6, { ...base, pageNumberFormat: 'numeric' })).toBe('3');
    expect(footerText(3, 6, { ...base, showPageNumbers: false })).toBe('');
  });
});

describe('paperPagesFor', () => {
  const layout: PdfLayout = {
    pages: 4,
    contentsPages: 1,
    breaks: [
      { page: 2, pageId: 'a', at: { kind: 'block', path: [1] } },
      { page: 3, pageId: 'b', at: { kind: 'section', section: 'prose', index: 1 } },
      { page: 4, pageId: 'b', at: { kind: 'block', path: [2] } },
    ],
    starts: [],
  };

  it('spans each prose page from its start to the next', () => {
    expect(prosePageSpan(layout, 0, base)).toEqual({ first: 1, last: 2 });
    expect(prosePageSpan(layout, 1, base)).toEqual({ first: 3, last: 4 });
  });

  it("shows only the edited page's breaks, each with the footer of the page it ends", () => {
    const doc = docOf('<p>One</p><p>Two</p><p>Three</p>');
    const a = paperPagesFor(layout, 'a', 0, doc, base);
    expect(a.ends).toEqual([{ at: { kind: 'block', pos: doc.child(0).nodeSize }, footer: 'Page 2 of 5' }]);
    expect(a.lastFooter).toBe('Page 3 of 5');
    const b = paperPagesFor(layout, 'b', 1, doc, base);
    expect(b.ends.map((end) => end.footer)).toEqual(['Page 4 of 5']);
    expect(b.lastFooter).toBe('Page 5 of 5');
  });

  it('prints nothing when the export prints no page numbers', () => {
    const doc = docOf('<p>One</p><p>Two</p>');
    const pages = paperPagesFor(layout, 'a', 0, doc, { ...base, showPageNumbers: false });
    expect(pages.ends.map((end) => end.footer)).toEqual(['']);
    expect(pages.lastFooter).toBe('');
  });
});

describe('page geometry', () => {
  it('gives the page in true mm, and its parts in CSS px', () => {
    const options: PDFExportOptions = { ...base, pageSize: 'a4', orientation: 'portrait', margins: { top: 20, right: 20, bottom: 20, left: 20 } };
    const variables = paperCssVariables(options);
    expect(variables['--paper-width']).toBe('210mm');
    expect(variables['--paper-height']).toBe('297mm');
    expect(variables['--paper-footer-space']).toBe('10mm');
    const geometry = paperGeometry(options);
    const mm = 96 / 25.4;
    expect(geometry.content).toBeCloseTo((297 - 20 - 20 - 10) * mm, 6);
    expect(geometry.foot).toBeCloseTo(30 * mm, 6);
    expect(geometry.head).toBeCloseTo(20 * mm, 6);
    expect(geometry.band).toBe(PAPER_BAND_PX);
    expect(paperGeometry({ ...options, showPageNumbers: false }).content).toBeCloseTo(257 * mm, 6);
  });
});

describe('fitPages', () => {
  const geometry: PaperGeometry = { content: 500, foot: 50, band: 24, head: 40, marginBottom: 40 };

  /** Give an element a box at `top` (jsdom lays nothing out). */
  const place = (element: HTMLElement, top: () => number) => {
    element.getBoundingClientRect = () => ({ top: top(), bottom: top(), left: 0, right: 0, width: 0, height: 0, x: 0, y: top(), toJSON: () => ({}) });
    element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
  };

  /** A column with a widget end, a row end and the last end, at tops that move with the room set before them. */
  const build = () => {
    const column = document.createElement('div');
    const root = document.createElement('div');
    root.style.paddingTop = '40px';
    const overlay = document.createElement('div');
    column.append(root, overlay);
    const room = (index: string) => parseFloat(column.style.getPropertyValue(`--paper-space-${index}`)) || 0;
    const widget = document.createElement('span');
    widget.className = 'paper-gap';
    widget.dataset['paperIndex'] = '0';
    widget.dataset['paperFoot'] = 'Page 1 of 3';
    const table = document.createElement('table');
    const row = document.createElement('tr');
    row.className = 'paper-row-break';
    row.dataset['paperIndex'] = '1';
    row.dataset['paperFoot'] = 'Page 2 of 3';
    table.append(row);
    const last = document.createElement('span');
    last.className = 'paper-gap paper-gap-last';
    last.dataset['paperIndex'] = 'last';
    last.dataset['paperFoot'] = 'Page 3 of 3';
    root.append(widget, table, last);
    place(column, () => 0);
    place(root, () => 0);
    place(widget, () => 500);
    place(row, () => 900 + room('0'));
    place(last, () => 1300 + room('0') + room('1'));
    return { column, root, overlay };
  };

  it("gives each page's end the room its page has left, and draws the gaps and footers", () => {
    const { column, root, overlay } = build();
    fitPages(root, overlay, geometry);
    // Page 1 holds 460 of 500; page 2 starts below the first end's margins and gap.
    expect(column.style.getPropertyValue('--paper-space-0')).toBe('40px');
    expect(column.style.getPropertyValue('--paper-space-1')).toBe('214px');
    expect(column.style.getPropertyValue('--paper-space-last')).toBe('214px');
    const drawn = [...overlay.children].map((child) => [child.className, (child as HTMLElement).style.top, child.textContent]);
    expect(drawn).toEqual([
      ['paper-footer', '570px', 'Page 1 of 3'],
      ['paper-band', '590px', ''],
      ['paper-footer', '1184px', 'Page 2 of 3'],
      ['paper-band', '1204px', ''],
      ['paper-footer', '1798px', 'Page 3 of 3'],
    ]);
  });

  it('lets a page whose text runs past the page on screen grow, and keeps the next sheets after it', () => {
    const column = document.createElement('div');
    const root = document.createElement('div');
    root.style.paddingTop = '40px';
    const overlay = document.createElement('div');
    column.append(root, overlay);
    const end = document.createElement('span');
    end.className = 'paper-gap';
    end.dataset['paperIndex'] = '0';
    end.dataset['paperFoot'] = '1';
    const last = document.createElement('span');
    last.className = 'paper-gap paper-gap-last';
    last.dataset['paperIndex'] = 'last';
    last.dataset['paperFoot'] = '2';
    root.append(end, last);
    place(column, () => 0);
    place(root, () => 0);
    place(end, () => 600);
    place(last, () => 900);
    fitPages(root, overlay, geometry);
    // Page 1's text takes 560 of 500: no room (unset is none), and its sheet ends below its text.
    expect(column.style.getPropertyValue('--paper-space-0')).toBe('');
    expect((overlay.children[1] as HTMLElement).style.top).toBe('650px');
    expect(column.style.getPropertyValue('--paper-space-last')).toBe('314px');
    expect((overlay.children[2] as HTMLElement).style.top).toBe(`${1264 - 20}px`);
  });

  it('writes nothing once the pages fit', () => {
    const { column, root, overlay } = build();
    fitPages(root, overlay, geometry);
    const set = vi.spyOn(column.style, 'setProperty');
    fitPages(root, overlay, geometry);
    expect(set).not.toHaveBeenCalled();
    expect(overlay.children[2]?.getAttribute('style')).toContain('1184px');
  });
});
