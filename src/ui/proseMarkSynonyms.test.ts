/**
 * Mark synonym parity — the client half (JP-514).
 *
 * `relay/tests/prose-fixtures/mark-synonyms.json` lists every way the editor's
 * Tiptap mark rules accept a mark: canonical tags, synonyms (`<b>`, `<i>`,
 * `<del>`, `<strike>`) and CSS styles. This test proves each case's expected
 * marks are what the **real editor schema** produces, and that every editor
 * parse rule is exercised by some case. The Rust half
 * (`relay/src/sync/prose_fixture_tests.rs`) requires the relay parser to
 * produce the same marks.
 *
 * The JP-432 contract test compares mark *names*, so it stayed green while the
 * relay unwrapped `<b>`, `<i>`, `<del>` and styled spans and an agent's
 * formatting vanished with `ok: true`. A new Tiptap parse rule now fails here
 * until a fixture case covers it, and the case then fails on the relay until
 * the relay accepts it.
 *
 * One normalization: the editor's TextStyle mark matches any `<span>` with a
 * `style` attribute, so a span styled only `font-weight: bold` also carries an
 * attribute-less `textStyle`. The relay deliberately keeps attribute-less
 * textStyle marks out of the CRDT; such a mark carries no formatting, so it is
 * ignored here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Mark, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

import { sharedProseExtensions } from './TiptapEditor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../relay/tests/prose-fixtures/mark-synonyms.json');

interface Case {
  name: string;
  html: string;
  marks: string[];
  /** The number of top-level blocks, where the case is about structure. */
  blocks?: number;
  why?: string;
}

const { cases } = JSON.parse(readFileSync(FIXTURES, 'utf8')) as { cases: Case[] };

/** The collaborative editor's schema, built as in `proseFixtures.test.ts`. */
const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
  ...sharedProseExtensions,
]);

function carriesFormatting(mark: Mark): boolean {
  if (mark.type.name !== 'textStyle') return true;
  return Object.values(mark.attrs).some((v) => v !== null && v !== undefined && v !== '');
}

function parse(html: string) {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(container);
}

/** The sorted names of the marks on the text node containing "X". */
function marksOnX(html: string): string[] | undefined {
  const doc = parse(html);
  let found: string[] | undefined;
  doc.descendants((node) => {
    if (found === undefined && node.isText && node.text?.includes('X')) {
      found = [...new Set(node.marks.filter(carriesFormatting).map((m) => m.type.name))].sort();
    }
    return found === undefined;
  });
  return found;
}

describe('mark synonym parity (cross-language)', () => {
  it('loads the shared fixtures', () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s: the editor produces the declared marks', (_name, c) => {
    expect(marksOnX(c.html), c.why ?? c.html).toEqual([...c.marks].sort());
    if (c.blocks !== undefined) expect(parse(c.html).childCount, c.why ?? c.html).toBe(c.blocks);
  });

  it('exercises every parse rule of every editor mark', () => {
    const uncovered: string[] = [];
    for (const [name, type] of Object.entries(schema.marks)) {
      for (const rule of type.spec.parseDOM ?? []) {
        if ('tag' in rule && rule.tag) {
          const tag = rule.tag.split(/[[:.\s]/)[0];
          const used = cases.some((c) => c.html.includes(`<${tag}>`) || c.html.includes(`<${tag} `));
          if (!used) uncovered.push(`${name}: tag <${tag}>`);
        } else if ('style' in rule && rule.style) {
          const prop = rule.style.split('=')[0];
          if (!cases.some((c) => c.html.includes(`${prop}:`))) uncovered.push(`${name}: style ${prop}`);
        }
      }
    }
    expect(uncovered, 'add a case to relay/tests/prose-fixtures/mark-synonyms.json').toEqual([]);
  });
});
