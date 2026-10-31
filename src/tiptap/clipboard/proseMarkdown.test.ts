/**
 * Prose as Markdown and plain text for "Copy as" (DSK-208).
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { sharedProseExtensions } from '../../ui/TiptapEditor';
import { proseToMarkdown, proseToPlainText, RULED_MARKS, RULED_NODES } from './proseMarkdown';

const schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
  ...sharedProseExtensions,
]);

function doc(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(div);
}

const SAMPLE = `
<h2>Plan</h2>
<p>Some <strong>bold</strong>, <em>italic</em>, <s>gone</s>, <code>code</code> and a <a href="https://example.com">link</a>.</p>
<ul><li><p>One</p><ul><li><p>Nested</p></li></ul></li><li><p>Two</p></li></ul>
<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>
<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Done</p></li><li data-type="taskItem" data-checked="false"><p>Todo</p></li></ul>
<blockquote><p>Quoted</p></blockquote>
<pre><code class="language-ts">const a = 1;</code></pre>
<table><tbody><tr><th><p>Name</p></th><th><p>Value</p></th></tr><tr><td><p>a|b</p></td><td><p>2</p></td></tr></tbody></table>
<img src="blob://abc" alt="Chart">
`;

describe('proseToMarkdown (DSK-208)', () => {
  it('writes GitHub-flavoured Markdown', () => {
    expect(proseToMarkdown(doc(SAMPLE))).toBe(
      [
        '## Plan',
        '',
        'Some **bold**, *italic*, ~~gone~~, `code` and a [link](https://example.com).',
        '',
        '- One',
        '  - Nested',
        '- Two',
        '',
        '3. Third',
        '4. Fourth',
        '',
        '- [x] Done',
        '- [ ] Todo',
        '',
        '> Quoted',
        '',
        '```ts',
        'const a = 1;',
        '```',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| a\\|b | 2 |',
        '',
        '![Chart](blob://abc)',
      ].join('\n'),
    );
  });

  it('writes math with dollars', () => {
    expect(proseToMarkdown(doc('<p>Area <span data-math-inline data-latex="\\pi r^2"></span></p>'))).toBe('Area $\\pi r^2$');
  });
});

describe('proseToPlainText (DSK-208)', () => {
  it('keeps the words and the structure, without Markdown syntax', () => {
    const text = proseToPlainText(doc(SAMPLE));
    expect(text).toContain('Plan\n\nSome bold, italic, gone, code and a link.');
    expect(text).toContain('- One\n  - Nested\n- Two');
    expect(text).toContain('Name\tValue\na|b\t2');
    expect(text).toContain('[Image: Chart]');
    expect(text).not.toMatch(/\*\*|~~|`|##|\]\(/);
  });
});

describe('copy-as coverage (DSK-208)', () => {
  it('has a rule for every node and mark in the prose schema', () => {
    const nodes = Object.keys(schema.nodes).filter((name) => name !== 'doc');
    expect(nodes.filter((name) => !RULED_NODES.has(name))).toEqual([]);
    expect(Object.keys(schema.marks).filter((name) => !RULED_MARKS.has(name))).toEqual([]);
  });
});
