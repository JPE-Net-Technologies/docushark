/**
 * Table structure ops (JP-416): moving a column/row and keeping header cells on
 * insert. Headless `Editor` so the real schema + prosemirror-tables primitives
 * run; assertions read `getHTML()` order / header-cell counts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';
import {
  moveColumnRight,
  moveColumnLeft,
  moveRowDown,
  addColumnAfterKeepHeader,
  addRowAfterKeepHeader,
} from './tableStructureCommands';
import * as cmd from '../ui/editorCommands';
import { handleTableTab } from './TableKeymap';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  return ed;
}

/** Put the cursor inside the cell whose text is `text`. */
function caretInCell(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  if (pos < 0) throw new Error(`no cell text ${text}`);
  ed.commands.setTextSelection(pos);
}

// Distinctive multi-char cell tokens so getHTML() ordering checks don't collide
// with letters inside markup (e.g. the 'a'/'b' in `<table>`/`<tbody>`).
const HEADER_TABLE =
  '<table><tbody>' +
  '<tr><th>COL1</th><th>COL2</th></tr>' +
  '<tr><td>VAL1</td><td>VAL2</td></tr>' +
  '</tbody></table>';

describe('table move column/row', () => {
  it('moves a column right (swaps order)', () => {
    const ed = make(HEADER_TABLE);
    caretInCell(ed, 'COL1'); // column 0
    expect(moveColumnRight(ed)).toBe(true);
    const html = ed.getHTML();
    expect(html.indexOf('COL2')).toBeLessThan(html.indexOf('COL1'));
    expect(html.indexOf('VAL2')).toBeLessThan(html.indexOf('VAL1'));
  });

  it('is a no-op past the left edge', () => {
    const ed = make(HEADER_TABLE);
    caretInCell(ed, 'COL1'); // column 0 — can't go further left
    const before = ed.getHTML();
    expect(moveColumnLeft(ed)).toBe(false);
    expect(ed.getHTML()).toBe(before);
  });

  it('moves a row down (swaps rows)', () => {
    const ed = make(HEADER_TABLE);
    caretInCell(ed, 'VAL1'); // row 1
    expect(moveRowDown(ed)).toBe(false); // already the last row
    caretInCell(ed, 'COL1'); // row 0
    expect(moveRowDown(ed)).toBe(true);
    const html = ed.getHTML();
    expect(html.indexOf('VAL1')).toBeLessThan(html.indexOf('COL1'));
  });
});

describe('table insert keeps header style', () => {
  it('promotes the new header-row cell to <th> on addColumnAfter', () => {
    const ed = make(HEADER_TABLE);
    caretInCell(ed, 'COL1'); // header row, column 0
    expect(addColumnAfterKeepHeader(ed)).toBe(true);
    const html = ed.getHTML();
    // 2 header cells originally → 3 after the new column inherits the header.
    expect((html.match(/<th/g) ?? []).length).toBe(3);
  });

  it('does not add header cells when there is no header row', () => {
    const ed = make('<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>');
    caretInCell(ed, 'a');
    expect(addRowAfterKeepHeader(ed)).toBe(true);
    expect((ed.getHTML().match(/<th/g) ?? []).length).toBe(0);
  });
});

describe('table insert inherits the reference formatting', () => {
  // Reference column (col 0): green background + cell align right + a
  // center-aligned paragraph. Col 1 is plain.
  const FORMATTED =
    '<table><tbody><tr>' +
    '<td style="background-color: rgb(0, 128, 0); text-align: right"><p style="text-align: center">REF</p></td>' +
    '<td><p>PLAIN</p></td>' +
    '</tr></tbody></table>';

  it('copies background, cell align, and paragraph text-align into a new column', () => {
    const ed = make(FORMATTED);
    caretInCell(ed, 'REF'); // reference column
    const before = ed.getHTML();
    expect((before.match(/background-color: rgb\(0, 128, 0\)/g) ?? []).length).toBe(1);

    expect(addColumnAfterKeepHeader(ed)).toBe(true);
    const html = ed.getHTML();
    // The new column's cell inherited the reference column's formatting.
    expect((html.match(/background-color: rgb\(0, 128, 0\)/g) ?? []).length).toBe(2);
    expect((html.match(/text-align: right/g) ?? []).length).toBe(2); // cell align
    expect((html.match(/text-align: center/g) ?? []).length).toBe(2); // paragraph
  });

  it('copies the reference row formatting into a new row', () => {
    const ed = make(FORMATTED);
    caretInCell(ed, 'REF');
    expect(addRowAfterKeepHeader(ed)).toBe(true);
    const html = ed.getHTML();
    // The new row's first cell mirrors the reference row's first cell.
    expect((html.match(/background-color: rgb\(0, 128, 0\)/g) ?? []).length).toBe(2);
    expect((html.match(/text-align: center/g) ?? []).length).toBe(2);
  });

  it('leaves a plain table unformatted (no background/align copied)', () => {
    const ed = make('<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>');
    caretInCell(ed, 'x');
    expect(addColumnAfterKeepHeader(ed)).toBe(true);
    const html = ed.getHTML();
    expect(html).not.toContain('background-color');
    expect(html).not.toContain('text-align');
  });

  // The live toolbar path: align via setCellAlign, then add a column/row.
  it('inherits alignment set via the setCellAlign command (toolbar path)', () => {
    const ed = make('<table><tbody><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></tbody></table>');
    caretInCell(ed, 'A1');
    cmd.setCellAlign(ed, 'right'); // align the cell like the toolbar button
    caretInCell(ed, 'A1');
    cmd.addColumnAfter(ed); // toolbar add → keep-header + inherit-format wrapper
    // A1 is right-aligned; the new column's row-0 cell should inherit it.
    expect((ed.getHTML().match(/text-align: right/g) ?? []).length).toBe(2);
  });

  // The Tab-to-add-row path (TableKeymap) must also inherit.
  it('inherits formatting when a row is added by Tab in the last cell', () => {
    const ed = make('<table><tbody><tr><td style="text-align: right">A1</td><td>B1</td></tr></tbody></table>');
    caretInCell(ed, 'B1'); // last cell → Tab adds a row
    expect(handleTableTab(ed)).toBe(true);
    // The new row's first cell mirrors row 0's first cell (right-aligned).
    expect((ed.getHTML().match(/text-align: right/g) ?? []).length).toBe(2);
  });
});
