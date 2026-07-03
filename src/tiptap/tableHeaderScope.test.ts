/**
 * Accessibility (JP-416): header cells render a `scope` so screen readers and
 * exported HTML/PDF treat them as headers. Defaults to `col` and round-trips.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';

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

describe('table header scope', () => {
  it('emits scope="col" on header cells by default', () => {
    const ed = make(
      '<table><tbody><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></tbody></table>',
    );
    const html = ed.getHTML();
    expect((html.match(/<th[^>]*scope="col"/g) ?? []).length).toBe(2);
    // Body cells stay plain <td> without a scope.
    expect(html).not.toMatch(/<td[^>]*scope=/);
  });

  it('round-trips an explicit scope="row"', () => {
    const ed = make(
      '<table><tbody><tr><th scope="row">R</th><td>x</td></tr></tbody></table>',
    );
    expect(ed.getHTML()).toContain('scope="row"');
  });
});
