/**
 * Cross-language prose round-trip corpus — the client half (JP-496).
 *
 * Loads `relay/tests/prose-fixtures/cases.json` and drives every case through
 * the **editor's own schema**. The Rust half
 * (`relay/src/sync/prose_fixture_tests.rs`) drives the same file through the
 * relay's parser/serializer, so the two prose models cannot drift.
 *
 * ## Why the manifest test wasn't enough
 *
 * `proseSchemaContract.test.ts` compares *manifests* — which node names, marks
 * and attrs each side declares. It stayed green through JP-495 while `fileRef`
 * was missing from two of the six relay sites that enumerate node types, one of
 * which **deleted the node outright**. A manifest cannot see behaviour on a real
 * document; this corpus is that layer.
 *
 * ## What is compared, and what deliberately is not
 *
 * The two sides are compared on the **document model** — the node sequence and
 * the attribute values — not on HTML text. HTML legitimately differs: the relay
 * stores a canonical form while the editor renders with presentation classes
 * (`tiptap-image`, `prose-gallery`), node-view chrome (`contenteditable`, the
 * task-list checkbox), a DOM-minted `<tbody>`, and its own attribute order.
 * Pinning the editor's HTML would assert mostly chrome, break on any Tiptap
 * upgrade, and train maintainers to paste in whatever the editor now emits —
 * which is exactly how a real regression would get blessed as expected.
 *
 * Attribute checks are a **subset** match, because the client materializes
 * schema defaults the relay omits (`colspan="1"`, a `<th>`'s `scope="col"`).
 * Neither side is wrong about those, and ignoring them lets one manifest serve
 * both without per-side carve-outs.
 *
 * The HTML fixed-point assertion still exists, on the Rust side, where it
 * belongs: HTML is the relay's storage format.
 *
 * This corpus paid for itself on its first run — it found `mathInline` and
 * `mathBlock` parsing to an **empty** `latex` on the client (the node survived,
 * the formula did not), because the attribute had no explicit `parseHTML` and
 * Tiptap's default looked for `latex` rather than the stored `data-latex`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema } from '@tiptap/core';
import {
  DOMParser as PMDOMParser,
  DOMSerializer,
  type Schema,
  type Node as PMNode,
} from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';

import { sharedProseExtensions } from './TiptapEditor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../relay/tests/prose-fixtures/cases.json');

interface NodeSpec {
  type: string;
  attrs?: Record<string, string>;
}

interface Case {
  name: string;
  why: string;
  html: string;
  nodes: NodeSpec[];
}

interface Fixtures {
  atoms: string[];
  cases: Case[];
}

function loadFixtures(): Fixtures {
  return JSON.parse(readFileSync(FIXTURES, 'utf8')) as Fixtures;
}

/**
 * The collaborative editor's schema — the same construction
 * `proseSchemaContract.test.ts` uses: history-disabled StarterKit with the
 * lowlight codeBlock replaced by the one in `sharedProseExtensions`.
 * Collaboration adds no schema nodes.
 */
const schema: Schema = getSchema([
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    codeBlock: false,
    history: false,
  }),
  ...sharedProseExtensions,
]);

function parse(html: string): PMNode {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(container);
}

/** The parsed document flattened to document order, text nodes excluded. */
function nodeModel(doc: PMNode): { type: string; attrs: Record<string, unknown> }[] {
  const out: { type: string; attrs: Record<string, unknown> }[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'text') out.push({ type: node.type.name, attrs: node.attrs });
    return true;
  });
  return out;
}

describe('prose round-trip corpus (cross-language)', () => {
  const fixtures = loadFixtures();

  it('discovers the shared fixtures', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
    expect(fixtures.atoms.length).toBeGreaterThan(0);
  });

  it('every case declares a node model', () => {
    // A case with no `nodes` would pass every assertion below while checking
    // nothing — the shape of guard this corpus exists to replace.
    const empty = fixtures.cases.filter((c) => !c.nodes?.length).map((c) => c.name);
    expect(empty, `these cases declare no nodes, so they assert nothing`).toEqual([]);
  });

  for (const c of fixtures.cases) {
    describe(`${c.name} — ${c.why.split('.')[0]}`, () => {
      it('parses into the declared node sequence', () => {
        expect(nodeModel(parse(c.html)).map((n) => n.type)).toEqual(c.nodes.map((n) => n.type));
      });

      it('preserves every declared attribute value', () => {
        const actual = nodeModel(parse(c.html));
        for (const [i, spec] of c.nodes.entries()) {
          for (const [key, want] of Object.entries(spec.attrs ?? {})) {
            // Stringified: the client stores `colspan` as a number and
            // `colwidth` as an array where the relay has strings, and the
            // fixture is a language-neutral file. `String([100,120])` is
            // "100,120", which is also the Tiptap wire form.
            expect(
              String(actual[i]?.attrs[key]),
              `${c.name}: node '${spec.type}' attr '${key}' was lost or changed by the parse`,
            ).toBe(want);
          }
        }
      });

      it('is stable when its own render is parsed again', () => {
        // Idempotence without pinning the render: whatever the editor emits
        // must parse back to the same document. A node that renders in a shape
        // its own parser cannot read is how content decays across save cycles.
        const once = parse(c.html);
        const container = document.createElement('div');
        container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(once.content));
        expect(nodeModel(parse(container.innerHTML))).toEqual(nodeModel(once));
      });
    });
  }

  it('the client schema treats every declared atom as an atom', () => {
    // The cross-language half of the Rust
    // `every_declared_atom_is_an_atom_to_the_validator` check. Both sides read
    // the same manifest, so a node that is an atom to one and not the other
    // fails on the side that is wrong.
    for (const name of fixtures.atoms) {
      const nodeType = schema.nodes[name];
      expect(nodeType, `declared atom '${name}' is missing from the client schema`).toBeDefined();
      expect(
        nodeType!.isLeaf || nodeType!.isAtom,
        `'${name}' is declared an atom in the shared fixtures but the client schema treats it ` +
          `as a container — its children would survive here and be stripped by the relay, so ` +
          `the two sides disagree about what the node even is`,
      ).toBe(true);
    }
  });
});
