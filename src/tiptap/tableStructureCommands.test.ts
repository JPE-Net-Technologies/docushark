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
