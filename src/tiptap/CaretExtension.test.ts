/**
 * The custom caret on Paper Mode's sheet (DSK-48): a caret colour too faint
 * against the paper gives way to the paper's ink.
 */
import { describe, expect, it } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';
import { faintOnPaper } from './CaretExtension';

/** An editor inside a sheet of `paper`, inside Paper Mode when `paperMode`. */
function setUp(paper: string, paperMode = true): { view: EditorView; caret: HTMLElement } {
  const panel = document.createElement('div');
  if (paperMode) panel.className = 'paper-mode';
  const sheet = document.createElement('div');
  sheet.style.backgroundColor = paper;
  const dom = document.createElement('div');
  sheet.append(dom);
  panel.append(sheet);
  document.body.append(panel);
  const caret = document.createElement('div');
  panel.append(caret);
  return { view: { dom } as unknown as EditorView, caret };
}

describe('faintOnPaper', () => {
  it('finds a light caret colour too faint on the paper', () => {
    const { view, caret } = setUp('#f9f6ee');
    caret.style.backgroundColor = '#f4f1e8';
    expect(faintOnPaper(caret, view)).toBe(true);
  });

  it('keeps a colour that stands out on the paper', () => {
    const { view, caret } = setUp('#f9f6ee');
    caret.style.backgroundColor = '#e8590c';
    expect(faintOnPaper(caret, view)).toBe(false);
    caret.style.backgroundColor = '#000000';
    expect(faintOnPaper(caret, view)).toBe(false);
  });

  it('leaves the caret alone outside Paper Mode', () => {
    const { view, caret } = setUp('#f9f6ee', false);
    caret.style.backgroundColor = '#f4f1e8';
    expect(faintOnPaper(caret, view)).toBe(false);
  });
});
