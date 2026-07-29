/**
 * Editor-lineage fixture — the JS→relay direction of the JP-326 wire harness
 * (JP-468).
 *
 * `relay/tests/yjs-fixtures/` (JP-326) proves relay-authored bytes decode in
 * the editor's yjs. Nothing proved the REVERSE — that a y-prosemirror-authored
 * document (the lineage every real collab doc has) survives the relay's
 * decode + flatten. JP-468's corruption lived exactly in that untested
 * direction's lifecycle.
 *
 * This test authors a deterministic editor lineage — fixed clientID,
 * incremental `updateYFragment` passes exactly like the live sync plugin
 * (base document → insert a floated image → append a marked paragraph; the
 * JP-468 reproduction's edit order) — and byte-pins it under
 * `relay/tests/editor-lineage/`:
 *
 *  - `update.bin`         — the lib0-v1 state update (the room's bytes)
 *  - `editor_render.html` — what the editor renders for it (JS truth)
 *  - `projection.html`    — the relay's flatten (written by the Rust half:
 *                           `cargo test regenerate_editor_lineage -- --ignored`)
 *
 * The Rust consumer (`relay/src/sync/lifecycle_tests.rs`) decodes the bytes
 * and asserts its projection matches `projection.html`. Regenerate here with
 * `REGEN_EDITOR_LINEAGE=1 bun run test --run src/collaboration/editorLineageFixture.test.ts`,
 * then regenerate the Rust projection — both sides must be green on the same
 * bytes, mirroring the JP-326 convention.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMSerializer } from '@tiptap/pm/model';
import type { Schema, Node as PMNode } from '@tiptap/pm/model';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import { sharedProseExtensions } from '../ui/TiptapEditor';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, '../../relay/tests/editor-lineage');

/** Deterministic: fixed room client id; content carries no wall-clock. */
const ROOM_CLIENT_ID = 4242;

const SENTENCE =
  'Does the tempo of background instrumental music change how many words a person can recall from a short study list?';

function toHTML(schema: Schema, doc: PMNode): string {
  const div = document.createElement('div');
  div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
  return div.innerHTML;
}

/** Author the lineage the way the live editor does: three separate
 *  `updateYFragment` reconciliations, so the item topology carries the real
 *  splits/tombstones of incremental editing — not one clean insert. */
function buildLineage(schema: Schema): Y.Doc {
  const ydoc = new Y.Doc();
  // Not a constructor option — yjs exposes clientID as an assignable field.
  // Must be set before the first transaction or the bytes aren't reproducible.
  ydoc.clientID = ROOM_CLIENT_ID;
  const frag = ydoc.getXmlFragment('prose:rt-page-1');
  const apply = (json: object) => {
    const node = schema.nodeFromJSON(json);
    node.check();
    ydoc.transact(() => {
      updateYFragment(ydoc, frag, node, { mapping: new Map(), isOMark: new Map() });
    });
  };

  const heading = {
    type: 'heading',
    attrs: { level: 1, id: 'blk-nBSmQmrosy' },
    content: [{ type: 'text', text: 'Does Music Tempo Affect Recall?' }],
  };
  const subhead = {
    type: 'heading',
    attrs: { level: 2, id: 'blk-rq000001' },
    content: [{ type: 'text', text: 'Research Question' }],
  };
  const sentence = {
    type: 'paragraph',
    attrs: { id: 'blk-sent0001' },
    content: [{ type: 'text', text: SENTENCE }],
  };
  const image = {
    type: 'image',
    attrs: {
      src: 'blob://1321e0c65302fd35ffcaa683f36d1bc8e63f0d38d5fceb82cfadb4b6bf1fb7ee',
      alt: 'download.png',
      width: 170,
      height: 170,
      float: 'right',
    },
  };
  const flag = {
    type: 'paragraph',
    attrs: { id: 'blk-wV_zWKVb3F' },
    content: [
      {
        type: 'text',
        text: 'DEBUG FLAG!',
        marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }],
      },
    ],
  };

  // Edit 1: base document.
  apply({ type: 'doc', content: [heading, subhead, sentence] });
  // Edit 2: insert the floated image after the title (JP-468 step 1).
  apply({ type: 'doc', content: [heading, image, subhead, sentence] });
  // Edit 3: append the marked flag paragraph (JP-468 step 2).
  apply({ type: 'doc', content: [heading, image, subhead, sentence, flag] });
  return ydoc;
}

describe('editor-lineage fixture (JS→relay wire direction)', () => {
  const schema = getSchema([
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      history: false,
    }),
    ...sharedProseExtensions,
  ]);

  it('committed bytes match regeneration (drift gate)', () => {
    const ydoc = buildLineage(schema);
    const update = Buffer.from(Y.encodeStateAsUpdate(ydoc));
    const render = toHTML(
      schema,
      yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('prose:rt-page-1'), schema),
    );

    const updatePath = join(FIXTURE_DIR, 'update.bin');
    const renderPath = join(FIXTURE_DIR, 'editor_render.html');

    if (process.env['REGEN_EDITOR_LINEAGE'] === '1') {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(updatePath, update);
      writeFileSync(renderPath, render);
      console.log(`regenerated ${updatePath} (${update.length} bytes)`);
      return;
    }

    expect(
      existsSync(updatePath),
      'committed fixture missing — run with REGEN_EDITOR_LINEAGE=1 to create it',
    ).toBe(true);
    const committed = readFileSync(updatePath);
    expect(
      committed.equals(update),
      'editor-lineage bytes drifted from regeneration — a yjs/y-prosemirror ' +
        'change altered the wire form. Regenerate BOTH sides: ' +
        'REGEN_EDITOR_LINEAGE=1 vitest run this file, then ' +
        '`cargo test regenerate_editor_lineage -- --ignored`.',
    ).toBe(true);
    expect(readFileSync(renderPath, 'utf8')).toBe(render);
  });
});
