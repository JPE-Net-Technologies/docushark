/**
 * T3 — relay ↔ client prose schema contract (JP-319).
 *
 * The relay's prose parser (`relay/src/sync/prose_parse.rs` + `prose_schema.rs`)
 * seeds a `prose:<page>` Y.XmlFragment with a fixed set of ProseMirror node
 * types. The client adopts that fragment and renders it via ReactNodeViews — so
 * if the relay can emit a node type the client schema doesn't define, or emits
 * an atom the client doesn't treat as a leaf, the desc-tree walk throws
 * "Cannot read properties of undefined (reading 'children')" on open.
 *
 * This pins the contract from the client side: every type the relay can emit
 * must exist in the schema the collab editor builds, and the relay's atoms must
 * be atoms here. Keep `RELAY_EMITTABLE_*` in sync with `prose_schema.rs`
 * (SIMPLE_BLOCKS + CUSTOM_PROSE_NODES) and the explicit cases in
 * `prose_parse.rs::map_block_element` (heading / codeBlock / hr / img).
 */

import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions } from './TiptapEditor';

// Every ProseMirror node type the relay parser can produce.
const RELAY_EMITTABLE_NODES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'codeBlock',
  'horizontalRule',
  'image',
  'bibliography',
  'citationInline',
  'fieldRef',
  'hardBreak',
] as const;

// Relay-emitted nodes that are atoms/leaves on the relay side (built childless).
// The client MUST treat these as atoms — otherwise an unexpected child crashes
// the node-view reconciliation.
const RELAY_EMITTABLE_ATOMS = [
  'image',
  'citationInline',
  'fieldRef',
  'horizontalRule',
  'hardBreak',
] as const;

describe('relay↔client prose schema contract (JP-319)', () => {
  // Mirror the collaborative editor's extension set (CollaborativeProseEditor:
  // history-disabled StarterKit with the lowlight codeBlock, plus the shared
  // extensions). Collaboration adds no schema nodes, so it's omitted here.
  const schema = getSchema([
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      history: false,
    }),
    ...sharedProseExtensions,
  ]);

  it('defines every node type the relay can emit', () => {
    for (const name of RELAY_EMITTABLE_NODES) {
      expect(schema.nodes[name], `client schema must define relay node '${name}'`).toBeDefined();
    }
  });

  it('treats every relay-emitted atom as a leaf/atom node', () => {
    for (const name of RELAY_EMITTABLE_ATOMS) {
      const nodeType = schema.nodes[name];
      expect(nodeType, `relay atom '${name}' missing from client schema`).toBeDefined();
      expect(
        nodeType!.isLeaf || nodeType!.isAtom,
        `relay atom '${name}' must be an atom/leaf in the client schema`,
      ).toBe(true);
    }
  });
});
