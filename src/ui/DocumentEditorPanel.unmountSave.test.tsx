/**
 * The panel saves its editor into the page store as it goes away. It writes by page
 * id, and most documents share `rt-page-1`, so it must be sure the page is still its
 * document's (DSK-230).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useEffect } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const h = vi.hoisted(() => ({ editor: null as unknown }));

vi.mock('./TiptapEditor', () => ({
  TiptapEditor: ({ onEditorReady }: { onEditorReady?: (editor: Editor | null, pageId: string | null) => void }) => {
    useEffect(() => {
      onEditorReady?.(h.editor as Editor, 'rt-page-1');
    }, []);
    return null;
  },
}));
vi.mock('./CollaborativeProseEditor', () => ({ CollaborativeProseEditor: () => null }));
vi.mock('./DocumentEditorToolbar', () => ({ DocumentEditorToolbar: () => null }));
vi.mock('./mobile/MobileProseToolbar', () => ({ MobileProseToolbar: () => null }));
vi.mock('./ProseSelectionBubble', () => ({ ProseSelectionBubble: () => null }));
vi.mock('./RichTextTabBar', () => ({ RichTextTabBar: () => null }));

import { DocumentEditorPanel } from './DocumentEditorPanel';
import { usePersistenceStore } from '../store/persistenceStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';

const PAGE = 'rt-page-1';

function seedPage(content: string) {
  useRichTextPagesStore.setState({
    pages: { [PAGE]: { id: PAGE, name: 'Prose', content, createdAt: 0, modifiedAt: 0 } },
    pageOrder: [PAGE],
    activePageId: PAGE,
  } as never);
}

const page = () => useRichTextPagesStore.getState().pages[PAGE]?.content;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 60)));

beforeEach(() => {
  h.editor = new Editor({ extensions: [StarterKit], content: '<p>Text in the editor</p>' });
  usePersistenceStore.setState({ currentDocumentId: 'doc-a' });
  seedPage('<p>Text in the editor</p>');
});

afterEach(() => {
  cleanup();
  (h.editor as Editor).destroy();
  usePersistenceStore.setState({ currentDocumentId: null });
});

describe('saving the editor when the panel goes away', () => {
  it('saves into its own document', async () => {
    const view = render(<DocumentEditorPanel />);
    await settle();
    act(() => {
      (h.editor as Editor).commands.setContent('<p>Edited just now</p>');
    });
    view.unmount();
    expect(page()).toBe('<p>Edited just now</p>');
  });

  it('leaves another document alone, though its page has the same id', async () => {
    const view = render(<DocumentEditorPanel />);
    await settle();
    // In one step, as a layout change can go with opening a document: the panel has
    // no chance to see the new document before it goes.
    act(() => {
      usePersistenceStore.setState({ currentDocumentId: 'doc-b' });
      seedPage('<p>The other document</p>');
      view.unmount();
    });
    expect(page()).toBe('<p>The other document</p>');
  });
});
