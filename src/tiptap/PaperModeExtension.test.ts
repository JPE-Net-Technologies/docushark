/**
 * Paper Mode's page breaks in the editor (DSK-48): decorations only, kept with
 * their text while typing, replaced by the next layout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions } from '../ui/TiptapEditor';
import { PaperModeExtension, setPaperPages, type PageEnd } from './PaperModeExtension';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

const make = (html: string): Editor => {
  editor = new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), ...sharedProseExtensions, PaperModeExtension],
    content: html,
  });
  return editor;
};
const gaps = (e: Editor) => [...e.view.dom.querySelectorAll<HTMLElement>('.paper-gap')];

describe('PaperModeExtension', () => {
  it('draws a gap where a page ends and a footer after the last, without changing the document', () => {
    const e = make('<p>First page.</p><p>Second page.</p>');
    const before = JSON.stringify(e.getJSON());
    const second = e.state.doc.child(0).nodeSize;
    setPaperPages(e.view, { ends: [{ at: { kind: 'block', pos: second }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: 'Page 2 of 2' });
    expect(gaps(e).map((g) => g.textContent)).toEqual(['Page 1 of 2', 'Page 2 of 2']);
    expect(gaps(e)[0]!.getAttribute('contenteditable')).toBe('false');
    expect(gaps(e)[0]!.nextElementSibling?.textContent).toBe('Second page.');
    expect(JSON.stringify(e.getJSON())).toBe(before);
  });

  it('keeps a gap with its text while typing before it, until the next layout', () => {
    const e = make('<p>First page.</p><p>Second page.</p>');
    const second = e.state.doc.child(0).nodeSize;
    setPaperPages(e.view, { ends: [{ at: { kind: 'block', pos: second }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: null });
    e.commands.insertContentAt(1, 'More words on the first page. ');
    expect(gaps(e)).toHaveLength(1);
    expect(gaps(e)[0]!.nextElementSibling?.textContent).toBe('Second page.');
  });

  it('breaks a paragraph at a line, inside its text', () => {
    const e = make('<p>Alpha beta gamma delta.</p>');
    const gammaPos = 1 + 'Alpha beta '.length;
    setPaperPages(e.view, { ends: [{ at: { kind: 'inline', pos: gammaPos }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: null });
    const paragraph = e.view.dom.querySelector('p')!;
    expect(paragraph.querySelector('.paper-gap')).not.toBeNull();
    expect(paragraph.textContent).toBe('Alpha beta Page 1 of 2gamma delta.');
  });

  it('replaces the gaps with the next layout, and clears them', () => {
    const e = make('<p>One.</p><p>Two.</p><p>Three.</p>');
    const doc = e.state.doc;
    const at = (index: number) => {
      let pos = 0;
      for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
      return pos;
    };
    setPaperPages(e.view, { ends: [{ at: { kind: 'block', pos: at(1) }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: null });
    setPaperPages(e.view, { ends: [{ at: { kind: 'block', pos: at(2) }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: null });
    expect(gaps(e)).toHaveLength(1);
    expect(gaps(e)[0]!.nextElementSibling?.textContent).toBe('Three.');
    setPaperPages(e.view, { ends: [], lastFooter: null });
    expect(gaps(e)).toHaveLength(0);
  });

  it('marks a table row that opens a page', () => {
    const e = make('<table><tr><th><p>Head</p></th></tr><tr><td><p>Row one</p></td></tr><tr><td><p>Row two</p></td></tr></table>');
    const table = e.state.doc.child(0);
    const rowPos = 1 + table.child(0).nodeSize + table.child(1).nodeSize;
    const rowEnd = rowPos + table.child(2).nodeSize;
    setPaperPages(e.view, { ends: [{ at: { kind: 'row', pos: rowPos, end: rowEnd }, footer: 'Page 1 of 2' }] as PageEnd[], lastFooter: null });
    const marked = e.view.dom.querySelector<HTMLElement>('tr.paper-row-break');
    expect(marked?.textContent).toBe('Row two');
    expect(marked?.getAttribute('data-paper-foot')).toBe('Page 1 of 2');
  });
});
