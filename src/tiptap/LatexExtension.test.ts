/**
 * Math attribute round-trip across client versions (JP-496).
 *
 * The `latex` source lives in `data-latex` in stored HTML — that is what the
 * relay's serializer writes (`prose_html.rs#math_inline_html`) and what this
 * extension emits. It had no explicit `parseHTML`, so Tiptap's default looked
 * for an attribute literally named `latex`: the node survived every HTML→PM
 * parse with an EMPTY formula. Live collaboration was unaffected (the Y.Doc
 * carries attrs directly), so it only bit the paths that re-parse stored HTML —
 * PDF export, the mirror service, version-history preview, and any
 * non-collaborative open.
 *
 * It is not merely a display fault. The prose projection writes the render back,
 * so **opening a document once under a build that cannot parse the formula
 * destroys it on disk**.
 *
 * That is also why the fix is two-sided, and why this file pins both sides:
 *
 * - we must READ `data-latex`, so relay-written and MCP-written math parses;
 * - we must keep WRITING the redundant bare `latex`, so a client built before
 *   this fix can still read what a newer client saved. Suppressing it — which
 *   the first version of the fix did — turns every stale-service-worker PWA into
 *   the destructive case above.
 */

import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

import { sharedProseExtensions } from '../ui/TiptapEditor';

const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
  ...sharedProseExtensions,
]);

function parse(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(div);
}

function render(html: string): string {
  const out = document.createElement('div');
  out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(parse(html).content));
  return out.innerHTML;
}

function latexOf(html: string, type: 'mathInline' | 'mathBlock'): string | null {
  let found: string | null = null;
  parse(html).descendants((n) => {
    if (n.type.name === type) found = (n.attrs['latex'] as string) ?? null;
    return true;
  });
  return found;
}

describe('reading math the relay wrote', () => {
  it('parses inline latex from data-latex', () => {
    // The relay emits `data-latex` and nothing else. This is the exact shape
    // that parsed to an empty formula before the fix.
    expect(latexOf('<p><span data-math-inline data-latex="x^2"></span></p>', 'mathInline')).toBe(
      'x^2',
    );
  });

  it('parses block latex from data-latex', () => {
    expect(latexOf('<div data-math-block data-latex="E = mc^2"></div>', 'mathBlock')).toBe(
      'E = mc^2',
    );
  });

  it('parses latex containing markup-ish and backslash-heavy source', () => {
    const src = '\\frac{a<b}{c>d} \\& \\alpha';
    const div = document.createElement('div');
    const span = document.createElement('span');
    span.setAttribute('data-math-inline', '');
    span.setAttribute('data-latex', src);
    div.appendChild(span);
    expect(latexOf(`<p>${div.innerHTML}</p>`, 'mathInline')).toBe(src);
  });
});

describe('writing math an older client can still read', () => {
  // A client built before JP-496 reads the attribute named `latex`. Dropping it
  // from our output makes that client read an empty formula AND persist the
  // loss. The redundancy is the compatibility shim; delete it only when no
  // pre-JP-496 client can still be in the wild.
  it('emits BOTH data-latex and the bare latex attribute (inline)', () => {
    const out = render('<p><span data-math-inline data-latex="x^2"></span></p>');
    expect(out, 'data-latex missing — the relay and our own parser read this').toContain(
      'data-latex="x^2"',
    );
    expect(
      / latex="x\^2"/.test(out),
      'bare `latex` missing — a pre-JP-496 client reads this one, gets an empty ' +
        'formula, and writes the loss back',
    ).toBe(true);
  });

  it('emits BOTH data-latex and the bare latex attribute (block)', () => {
    const out = render('<div data-math-block data-latex="E = mc^2"></div>');
    expect(out).toContain('data-latex="E = mc^2"');
    expect(/ latex="E = mc\^2"/.test(out)).toBe(true);
  });
});

describe('the formula survives a full round-trip', () => {
  for (const [label, html] of [
    ['inline', '<p><span data-math-inline data-latex="\\int_0^1 x^2 dx"></span></p>'],
    ['block', '<div data-math-block data-latex="\\sum_{i=0}^n i"></div>'],
  ] as const) {
    it(`${label}: parse → render → parse keeps the source`, () => {
      const type = label === 'inline' ? 'mathInline' : 'mathBlock';
      const first = latexOf(html, type);
      expect(first).toBeTruthy();
      // The second trip is the one that mattered: it is what a save-then-reopen
      // does, and where the empty formula got persisted.
      expect(latexOf(render(html), type)).toBe(first);
    });
  }
});
