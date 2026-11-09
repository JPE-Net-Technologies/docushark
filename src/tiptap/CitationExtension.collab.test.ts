/**
 * A newer build's citation fields survive edits in this one (DSK-235).
 *
 * y-prosemirror builds each node from the attributes its schema declares. When
 * it rewrites a node (a label write-back, an edit to the citation, a change of
 * the block around it), the shared copy loses any attribute the schema doesn't
 * declare. So a build without `items` and `passage` would strip a cluster and a
 * linked passage for everyone the moment it touched that citation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';
import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { sharedProseExtensions } from '../ui/TiptapEditor';
import { CitationInline } from './CitationExtension';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const items = JSON.stringify([{ refId: 'knuth1997', locator: 'p. 42' }, { refId: 'lamport1994' }]);
const passage = JSON.stringify({ page: 3, quote: 'premature optimization' });

/** The shared document as a newer build left it: a paragraph holding a cluster. */
function sharedDocWithCluster(): { ydoc: Y.Doc; fragment: Y.XmlFragment } {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment('prose:p1');
  const paragraph = new Y.XmlElement('paragraph');
  const citation = new Y.XmlElement('citationInline');
  citation.setAttribute('refId', 'knuth1997');
  citation.setAttribute('label', '[1, 2]');
  citation.setAttribute('items', items);
  citation.setAttribute('passage', passage);
  paragraph.insert(0, [new Y.XmlText('see '), citation]);
  fragment.insert(0, [paragraph]);
  return { ydoc, fragment };
}

function findCitation(fragment: Y.XmlFragment): Y.XmlElement | undefined {
  for (const node of fragment.createTreeWalker((n) => n instanceof Y.XmlElement)) {
    if ((node as Y.XmlElement).nodeName === 'citationInline') return node as Y.XmlElement;
  }
  return undefined;
}

let editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) {
    editor.view.dom.parentElement?.remove();
    editor.destroy();
  }
  editors = [];
});

function bind(ydoc: Y.Doc, proseExtensions: Extensions): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
      ...proseExtensions,
      Collaboration.configure({ document: ydoc, field: 'prose:p1' }),
    ],
  });
  editors.push(editor);
  return editor;
}

/** Rewrite the citation node itself, as an edit to its locator would. */
function rewriteCitation(editor: Editor): void {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (node.type.name === 'citationInline') pos = at;
  });
  const attrs = { ...editor.state.doc.nodeAt(pos)!.attrs, locator: 'p. 43' };
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, attrs));
}

describe('citation fields from a newer build in a shared document (DSK-235)', () => {
  it('a build without the declarations strips them when it rewrites the citation (the hazard)', async () => {
    // An older build: the citation node as it was before DSK-235.
    const OlderCitation = CitationInline.extend({
      addAttributes() {
        const attrs = { ...this.parent?.() };
        delete attrs['items'];
        delete attrs['passage'];
        return attrs;
      },
    });
    const older = sharedProseExtensions.map((ext) => (ext.name === 'citationInline' ? OlderCitation : ext));
    const { ydoc, fragment } = sharedDocWithCluster();
    const editor = bind(ydoc, older);
    await flush();

    rewriteCitation(editor);
    await flush();

    const after = findCitation(fragment);
    expect(after?.getAttribute('locator')).toBe('p. 43');
    expect(after?.getAttribute('items')).toBeUndefined();
    expect(after?.getAttribute('passage')).toBeUndefined();
  });

  it('this build keeps them through typing beside them, a rewrite of the citation and a new block type', async () => {
    const { ydoc, fragment } = sharedDocWithCluster();
    const editor = bind(ydoc, sharedProseExtensions);
    await flush();

    editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize - 1, ' and more');
    await flush();
    rewriteCitation(editor);
    await flush();
    editor.chain().setTextSelection(2).setNode('heading', { level: 2 }).run();
    await flush();

    expect(editor.getText()).toContain('and more');
    expect(editor.state.doc.child(0).type.name).toBe('heading');
    const after = findCitation(fragment);
    expect(after?.getAttribute('locator')).toBe('p. 43');
    expect(after?.getAttribute('items')).toBe(items);
    expect(after?.getAttribute('passage')).toBe(passage);
    expect(after?.getAttribute('label')).toBe('[1, 2]');
  });
});
