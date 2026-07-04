/**
 * JP-428 field repro: relay-derived documents carry a FOSSILIZED legacy
 * `richTextContent` (single-page Tiptap JSON frozen at the doc's first REST
 * save — the relay only maintains `richTextPages`). Loading such a doc must
 * not seed the live rich-text store from the fossil: when the multi-page
 * format is present, the pages store owns prose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePersistenceStore, saveDocumentToStorage } from './persistenceStore';
import { useRichTextStore } from './richTextStore';
import { useRichTextPagesStore } from './richTextPagesStore';
import { DOCUMENT_VERSION } from '../types/Document';
import type { DiagramDocument } from '../types/Document';

const FULL_PROSE =
  '<p>Hello</p><h1>My Gallery</h1><p>Welcome.</p>' +
  '<div data-gallery data-layout="grid"><div class="gallery-items">' +
  '<img src="blob://abc" alt="a" width="220"></div></div>' +
  '<h1>Heading After Gallery</h1><p>Welcome, again.</p>';

/** A local copy of a relay doc: stale legacy prose + current multi-page prose. */
function fossilDoc(): DiagramDocument {
  return {
    id: 'doc-fossil-repro',
    name: 'Fossil Repro',
    pages: {
      p1: { id: 'p1', name: 'Page 1', shapes: {}, shapeOrder: [], createdAt: 1, modifiedAt: 2 },
    },
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 1,
    modifiedAt: 2,
    version: DOCUMENT_VERSION,
    // The fossil: first-save-era prose, long since superseded.
    richTextContent: {
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
      },
      version: 1,
    },
    richTextPages: {
      pageOrder: ['rt-1'],
      pages: {
        'rt-1': { id: 'rt-1', name: 'Notes', content: FULL_PROSE, order: 0, createdAt: 1, modifiedAt: 2 },
      },
      activePageId: 'rt-1',
    },
  } as DiagramDocument;
}

describe('loading a doc with a fossilized legacy richTextContent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not seed the live rich-text store from the fossil when richTextPages exists', () => {
    const doc = fossilDoc();
    saveDocumentToStorage(doc);
    const ok = usePersistenceStore.getState().loadDocument(doc.id);
    expect(ok).toBe(true);

    // Pages store (the prose owner) carries the real content.
    const page = useRichTextPagesStore.getState().pages['rt-1'];
    expect(page?.content).toContain('Heading After Gallery');

    // The live store must NOT hold the fossil — the editor mounts from it,
    // and the fossil is what made restored copies open as "Hello"-only.
    const live = useRichTextStore.getState().getContent();
    expect(JSON.stringify(live.content)).not.toContain('Hello');
  });

  it('still loads legacy-only documents through richTextContent', () => {
    const doc = fossilDoc();
    delete doc.richTextPages;
    saveDocumentToStorage(doc);
    const ok = usePersistenceStore.getState().loadDocument(doc.id);
    expect(ok).toBe(true);
    const live = useRichTextStore.getState().getContent();
    expect(JSON.stringify(live.content)).toContain('Hello');
  });
});
