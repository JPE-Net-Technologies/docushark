/**
 * Per-column alignment (JP-416): the table cell `align` attribute parses from
 * and renders to a `text-align` style, and `setCellAlign` applies it to the
 * focused cell. Headless `Editor` so the real schema + the TableCell/TableHeader
 * `align` addAttributes run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';
import { setCellAlign } from '../ui/editorCommands';

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

function caretInCell(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  if (pos < 0) throw new Error(`no cell text ${text}`);
  ed.commands.setTextSelection(pos);
}

describe('table cell alignment', () => {
  it('round-trips an align attribute through getHTML', () => {
    const ed = make(
      '<table><tbody><tr><td style="text-align: right">RIGHT</td><td>PLAIN</td></tr></tbody></table>',
    );
    expect(ed.getHTML()).toContain('text-align: right');
  });

  it('setCellAlign sets alignment on the focused cell, and null clears it', () => {
    const ed = make('<table><tbody><tr><td>CELL</td></tr></tbody></table>');
    caretInCell(ed, 'CELL');

    setCellAlign(ed, 'center');
    expect(ed.getHTML()).toContain('text-align: center');

    setCellAlign(ed, null);
    expect(ed.getHTML()).not.toContain('text-align');
  });

  it('preserves alignment alongside a cell background color', () => {
    const ed = make(
      '<table><tbody><tr><td style="text-align: center; background-color: rgb(255, 0, 0)">X</td></tr></tbody></table>',
    );
    const html = ed.getHTML();
    expect(html).toContain('text-align: center');
    expect(html).toContain('background-color: rgb(255, 0, 0)');
  });
});
