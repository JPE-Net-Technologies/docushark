/**
 * Tests for the lowlight CodeBlock — schema-level serialization round-trip via
 * ProseMirror DOMParser/DOMSerializer (no React nodeView mount needed). Covers
 * the `language` attribute and backwards-compat with legacy plain code blocks.
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { CodeBlock } from './CodeBlockExtension';

const schema: Schema = getSchema([StarterKit.configure({ history: false, codeBlock: false }), CodeBlock]);

function htmlToHtml(html: string): string {
  const input = document.createElement('div');
  input.innerHTML = html;
  const doc = PMDOMParser.fromSchema(schema).parse(input);
  const frag = DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
  const out = document.createElement('div');
  out.appendChild(frag);
  return out.innerHTML;
}

describe('code block serialization', () => {
  it('registers a codeBlock node with a language attribute', () => {
    const codeBlock = schema.nodes['codeBlock'];
    expect(codeBlock).toBeDefined();
    expect(codeBlock!.spec.attrs).toHaveProperty('language');
  });

  it('round-trips a code block with a language class', () => {
    const out = htmlToHtml('<pre><code class="language-python">print(1)</code></pre>');
    expect(out).toContain('language-python');
    expect(out).toContain('print(1)');
  });

  it('preserves a legacy plain code block (no language)', () => {
    const out = htmlToHtml('<pre class="tiptap-code-block"><code>old code</code></pre>');
    expect(out).toContain('old code');
    expect(out).toContain('<pre');
    expect(out).toContain('<code');
  });
});
