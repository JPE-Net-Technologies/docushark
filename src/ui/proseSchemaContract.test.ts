/**
 * Relay ↔ client prose schema contract (JP-319 crash-safety + JP-432 parity).
 *
 * Two directions, both derived from the real editor schema (`getSchema`) so
 * neither can silently drift:
 *
 * 1. **relay ⊆ client (crash-safety, JP-319).** Every node the relay parser can
 *    emit must exist in the client schema, and the relay's atoms must be atoms
 *    here — else the desc-tree walk throws "Cannot read properties of undefined
 *    (reading 'children')" on open and y-prosemirror DELETES the node.
 *
 * 2. **client ⊆ relay (parity, JP-432).** Every node/mark/persisted-attr the
 *    editor can store must be modeled by the relay's prose round-trip — else it
 *    is silently lost on any reserialize / flatten→rehydrate (how task lists,
 *    embedded groups, code-block language, and highlight/text colour were being
 *    dropped). A new editor node/mark/attr that is neither modeled nor an
 *    explicit render-only carve-out fails CI, forcing a conscious choice: wire
 *    the relay, or declare it unpersisted.
 *
 * The RELAY_* manifests below mirror `relay/src/sync/prose_schema.rs`
 * (SIMPLE_BLOCKS / MARKS / CUSTOM_PROSE_NODES / BLOCK_ATTRS / MARK_ATTRS) plus
 * the explicit hand-written arms in `prose_parse.rs` / `prose_html.rs`
 * (heading / codeBlock / image / hr / callout / figure / gallery / task list /
 * embeddedGroup). Keep them in sync when the relay's prose model changes.
 */

import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions } from './TiptapEditor';

// ---- relay-modeled prose schema (mirror of prose_schema.rs + explicit arms) ----

/** Every ProseMirror node type the relay parser can produce / round-trip. */
const RELAY_NODES = new Set<string>([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote',
  'table', 'tableRow', 'tableCell', 'tableHeader', 'codeBlock', 'horizontalRule',
  'hardBreak', 'image', 'citationInline', 'bibliography', 'fieldRef', 'mathInline',
  'mathBlock', 'callout', 'figure', 'figcaption', 'gallery',
  // JP-432
  'taskList', 'taskItem', 'embeddedGroup',
  // JP-495: the inline file chip.
  'fileRef',
]);

/** Relay-emitted nodes built childless — the client MUST treat these as atoms. */
const RELAY_ATOMS = new Set<string>([
  'image', 'citationInline', 'fieldRef', 'mathInline', 'mathBlock',
  'horizontalRule', 'bibliography', 'hardBreak', 'embeddedGroup',
  'fileRef',
]);

/** Every inline mark the relay round-trips (prose_schema.rs MARKS + link). */
const RELAY_MARKS = new Set<string>([
  'highlight', 'textStyle', 'bold', 'italic', 'underline', 'strike',
  'superscript', 'subscript', 'code', 'link',
]);

/**
 * Per-node/mark attributes the relay persists (mirror of BLOCK_ATTRS + MARK_ATTRS
 * + the attrs each hand-written node/mark carries). An editor attr absent here
 * and from RENDER_ONLY_ATTRS is a parity gap.
 */
const RELAY_ATTRS: Record<string, Set<string>> = {
  // `id` = durable block id (JP-432 Pillar C), a BLOCK_ATTRS row on the three
  // addressable text leaves; minted by BlockIdExtension / the MCP tool layer.
  heading: new Set(['level', 'textAlign', 'id']),
  paragraph: new Set(['textAlign', 'id']),
  orderedList: new Set(['start', 'type']),
  // colspan/rowspan/colwidth = JP-432 Pillar D: spans as numbers, colwidth as
  // a native array; serializer skips the ==1 defaults (SKIP_ATTR_DEFAULTS).
  tableCell: new Set(['backgroundColor', 'align', 'colspan', 'rowspan', 'colwidth']),
  tableHeader: new Set(['backgroundColor', 'align', 'scope', 'colspan', 'rowspan', 'colwidth']),
  codeBlock: new Set(['language', 'id']),
  image: new Set(['src', 'alt', 'title', 'width', 'height', 'float']),
  taskItem: new Set(['checked']),
  // JP-495: `blobRef` holds the `blob://<hash>` URI form, not a bare hash, so
  // the reference walk can find it inside the serialized HTML string.
  fileRef: new Set(['blobRef', 'fileName', 'mimeType', 'fileSize']),
  embeddedGroup: new Set(['groupId', 'groupName']),
  callout: new Set(['variant']),
  gallery: new Set(['layout']),
  figure: new Set([]),
  citationInline: new Set(['refId', 'locator', 'label']),
  fieldRef: new Set(['name', 'label']),
  mathInline: new Set(['latex']),
  mathBlock: new Set(['latex']),
  bibliography: new Set(['bibHtml', 'scope']),
  highlight: new Set(['color']),
  textStyle: new Set(['color']),
  link: new Set(['href']),
};

/**
 * Editor attrs the relay intentionally does NOT persist — render-only config the
 * editor re-applies from constant `HTMLAttributes`, or runtime-only state. Each
 * is a conscious carve-out, not a silent gap. Documented per JP-432 review.
 */
const RENDER_ONLY_ATTRS: Record<string, Set<string>> = {
  // Link `class`/`rel` are constant HTMLAttributes (`tiptap-link`,
  // `noopener noreferrer`) the editor re-applies at render; `target` isn't
  // settable via the link UI today. Relay stores href only (explicit decision).
  link: new Set(['target', 'rel', 'class']),
  // Runtime PNG cache for the embed preview — deliberately not serialized.
  embeddedGroup: new Set(['cachedImageUrl']),
};

/** Base ProseMirror nodes with no persisted content of their own. */
const STRUCTURAL_NODES = new Set<string>(['doc', 'text']);

describe('relay↔client prose schema contract', () => {
  // Mirror the collaborative editor's schema: history-disabled StarterKit with the
  // lowlight codeBlock disabled (replaced by CodeBlock in sharedProseExtensions),
  // plus the shared extensions. Collaboration adds no schema nodes.
  const schema = getSchema([
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      history: false,
    }),
    ...sharedProseExtensions,
  ]);

  // ---- 1. relay ⊆ client (crash-safety, JP-319) ----

  it('client defines every node the relay can emit', () => {
    for (const name of RELAY_NODES) {
      expect(schema.nodes[name], `client schema must define relay node '${name}'`).toBeDefined();
    }
  });

  it('client treats every relay-emitted atom as an atom/leaf', () => {
    for (const name of RELAY_ATOMS) {
      const nodeType = schema.nodes[name];
      expect(nodeType, `relay atom '${name}' missing from client schema`).toBeDefined();
      expect(
        nodeType!.isLeaf || nodeType!.isAtom,
        `relay atom '${name}' must be an atom/leaf in the client schema`,
      ).toBe(true);
    }
  });

  // ---- 2. client ⊆ relay (parity — no silent loss, JP-432) ----

  it('relay models every node the editor persists', () => {
    for (const name of Object.keys(schema.nodes)) {
      if (STRUCTURAL_NODES.has(name)) continue;
      expect(
        RELAY_NODES.has(name),
        `editor node '${name}' is not modeled by the relay prose round-trip — it will be ` +
          `silently lost on reserialize/rehydrate. Wire it in prose_schema.rs/prose_parse.rs/` +
          `prose_html.rs (and add it to RELAY_NODES), or add it to STRUCTURAL_NODES if it is ` +
          `a non-persisted base node.`,
      ).toBe(true);
    }
  });

  it('relay models every mark the editor persists', () => {
    for (const name of Object.keys(schema.marks)) {
      expect(
        RELAY_MARKS.has(name),
        `editor mark '${name}' is not modeled by the relay (prose_schema.rs MARKS) — it will ` +
          `be silently lost on round-trip. Add it to MARKS/MARK_ATTRS and RELAY_MARKS.`,
      ).toBe(true);
    }
  });

  it('relay models every persisted attribute the editor stores', () => {
    const violations: string[] = [];
    const check = (kind: 'node' | 'mark', name: string, attrs: Record<string, unknown>) => {
      const modeled = RELAY_ATTRS[name] ?? new Set<string>();
      const renderOnly = RENDER_ONLY_ATTRS[name] ?? new Set<string>();
      for (const attr of Object.keys(attrs)) {
        if (!modeled.has(attr) && !renderOnly.has(attr)) {
          violations.push(`${kind} '${name}' persists unmodeled attr '${attr}'`);
        }
      }
    };
    for (const [name, type] of Object.entries(schema.nodes)) {
      if (STRUCTURAL_NODES.has(name) || !RELAY_NODES.has(name)) continue;
      check('node', name, type.spec.attrs ?? {});
    }
    for (const [name, type] of Object.entries(schema.marks)) {
      check('mark', name, type.spec.attrs ?? {});
    }
    expect(
      violations,
      `editor persists attributes the relay neither models (RELAY_ATTRS) nor carves out ` +
        `(RENDER_ONLY_ATTRS) — each is a silent round-trip loss. Wire a BLOCK_ATTRS/MARK_ATTRS ` +
        `row, or declare it render-only:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
