/**
 * proseFragmentCheck (JP-328, Pillar 1a) — the fragment pre-flight that keeps a
 * malformed relay Y.Doc fragment from ever mounting the live editor (which would
 * crash NodeView reconciliation and blank the page).
 *
 * A well-formed fragment builds + validates cleanly (mount the editor); a
 * fragment carrying a schema-invalid node fails the check (fall back to the
 * read-only ProsePreview). We build the fragments the same way the relay seeds
 * them — XmlElement nodes inside the `prose:<page>` fragment — so this exercises
 * the real y-prosemirror build path, not a mock.
 */

import * as Y from 'yjs';
import { isFragmentRenderable } from './proseFragmentCheck';

/** Append a `<p>text</p>` block to a prose fragment (a valid paragraph). */
function appendParagraph(frag: Y.XmlFragment, text: string): void {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  frag.insert(frag.length, [p]);
}

describe('isFragmentRenderable', () => {
  it('returns true for a well-formed prose fragment', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('prose:p1');
    appendParagraph(frag, 'hello world');
    expect(isFragmentRenderable(doc, 'prose:p1')).toBe(true);
  });

  it('returns true for an empty fragment (trivially renderable)', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('prose:p1'); // create, leave empty
    expect(isFragmentRenderable(doc, 'prose:p1')).toBe(true);
  });

  it('returns false for an unknown node type the client schema cannot render', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('prose:p1');
    // A node type that doesn't exist in the prose schema — the exact class of
    // drift that crashes the live editor's reconciliation on open.
    frag.insert(0, [new Y.XmlElement('totallyBogusBlock')]);
    expect(isFragmentRenderable(doc, 'prose:p1')).toBe(false);
  });

  it('returns false for an atom node carrying children (image with content)', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment('prose:p1');
    // `image` is an atom/leaf in the schema; giving it children violates the
    // schema and crashes NodeView reconciliation ("reading 'children'").
    const img = new Y.XmlElement('image');
    img.setAttribute('src', 'blob:x');
    img.insert(0, [new Y.XmlText('illegal child')]);
    frag.insert(0, [img]);
    expect(isFragmentRenderable(doc, 'prose:p1')).toBe(false);
  });
});
