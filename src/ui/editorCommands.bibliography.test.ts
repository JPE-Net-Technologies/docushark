/**
 * One bibliography per document (DSK-200). The ribbon refused a second while
 * `/bibliography` added one; both now go through `insertBibliographyOnce`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CitationInline, Bibliography } from '../tiptap/CitationExtension';
import { SLASH_COMMANDS } from '../tiptap/slashCommands';
import { useNotificationStore } from '../store/notificationStore';

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  useNotificationStore.setState({ notifications: [] });
});

const bibliographies = (doc: Editor['state']['doc']) => {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'bibliography') count++;
  });
  return count;
};

describe('insertBibliographyOnce (DSK-200)', () => {
  it('adds the bibliography once from "/", and says why the second did nothing', () => {
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit.configure({ history: false }), CitationInline, Bibliography],
      content: '<p></p>',
    });
    const slash = SLASH_COMMANDS.find((command) => command.id === 'bibliography')!;
    slash.run(editor);
    expect(bibliographies(editor.state.doc)).toBe(1);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    slash.run(editor);
    expect(bibliographies(editor.state.doc)).toBe(1);
    expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain('Bibliography already added');
  });
});
