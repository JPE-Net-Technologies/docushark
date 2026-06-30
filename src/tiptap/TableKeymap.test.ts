/**
 * TableKeymap (JP-416) — Tab navigation in tables. We test the extracted
 * handlers directly (dispatching real key events through the keymap is brittle
 * in jsdom). Headless `Editor` so the real table schema + commands run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';
import { handleTableTab, handleTableShiftTab } from './TableKeymap';

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

function caretIn(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  ed.commands.setTextSelection(pos);
}

const rows = (ed: Editor) => (ed.getHTML().match(/<tr/g) ?? []).length;

const ROW = '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>';

describe('TableKeymap Tab handling', () => {
  it('Tab in the last cell appends a new row', () => {
    const ed = make(ROW);
    caretIn(ed, 'B'); // last cell
    expect(rows(ed)).toBe(1);
    expect(handleTableTab(ed)).toBe(true);
    expect(rows(ed)).toBe(2);
  });

  it('Tab in a non-last cell advances without adding a row', () => {
    const ed = make(ROW);
    caretIn(ed, 'A'); // first cell
    expect(handleTableTab(ed)).toBe(true);
    expect(rows(ed)).toBe(1);
  });

  it('Tab outside a table is not handled (returns false)', () => {
    const ed = make('<p>OUTSIDE</p>');
    caretIn(ed, 'OUTSIDE');
    expect(handleTableTab(ed)).toBe(false);
    expect(handleTableShiftTab(ed)).toBe(false);
  });
});
