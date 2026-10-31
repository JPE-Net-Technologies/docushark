/**
 * Naming the open document from its content (DSK-209), through a real editor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ySyncPluginKey } from 'y-prosemirror';
import { usePersistenceStore, UNTITLED_DOCUMENT_NAME } from '../store/persistenceStore';
import { useNotificationStore } from '../store/notificationStore';
import { useDocumentNamingStore } from '../services/documentNaming';
import { useDocumentNaming, PROMPT_AFTER_PAUSE_MS } from './useDocumentNaming';

let editor: Editor;
const rename = vi.fn((name: string) => usePersistenceStore.setState({ currentDocumentName: name }));

function open(name = UNTITLED_DOCUMENT_NAME, id: string | null = 'doc-1') {
  usePersistenceStore.setState({ currentDocumentName: name, currentDocumentId: id, renameDocument: rename });
  renderHook(() => useDocumentNaming(editor));
}

const name = () => usePersistenceStore.getState().currentDocumentName;
const toasts = () => useNotificationStore.getState().notifications;

beforeEach(() => {
  localStorage.clear();
  rename.mockClear();
  useNotificationStore.setState({ notifications: [] });
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null; });
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: [StarterKit], content: '<p></p>' });
});

afterEach(() => {
  cleanup();
  editor.destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('naming a document from a leading heading (DSK-209)', () => {
  it('waits until the writer moves past the heading, then names it, with an Undo that sticks', () => {
    open();
    editor.commands.insertContent('<h1>Quarterly Report</h1>');
    expect(name()).toBe(UNTITLED_DOCUMENT_NAME);

    editor.commands.splitBlock();
    expect(name()).toBe('Quarterly Report');
    expect(toasts()[0]?.message).toBe('Named “Quarterly Report” from its heading.');

    toasts()[0]!.onAction!();
    expect(name()).toBe(UNTITLED_DOCUMENT_NAME);
    editor.commands.insertContent('More');
    editor.commands.setTextSelection(1);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(name()).toBe(UNTITLED_DOCUMENT_NAME);
  });

  it("lets Undo touch only that document's automatic name", () => {
    open();
    editor.commands.insertContent('<h1>Quarterly Report</h1>');
    editor.commands.splitBlock();
    const undo = toasts()[0]!.onAction!;

    // Renamed by hand since: Undo leaves it.
    usePersistenceStore.setState({ currentDocumentName: 'Q3 report (final)' });
    undo();
    expect(name()).toBe('Q3 report (final)');

    // Another document open since: Undo leaves that one too.
    usePersistenceStore.setState({ currentDocumentId: 'doc-2', currentDocumentName: 'Quarterly Report' });
    undo();
    expect(name()).toBe('Quarterly Report');
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('names it at once when the heading arrives by paste', () => {
    open();
    editor.commands.focus();
    editor.view.pasteHTML('<h1>Pasted Title</h1><p>Body</p>');
    expect(name()).toBe('Pasted Title');
  });

  it('never renames a document that already has a name', () => {
    open('Board minutes');
    editor.commands.insertContent('<h1>Another</h1>');
    editor.commands.splitBlock();
    expect(rename).not.toHaveBeenCalled();
  });

  it('leaves an old untitled document alone when it is merely opened', () => {
    open();
    editor.commands.setContent('<h1>Old heading</h1><p>Old body</p>');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(rename).not.toHaveBeenCalled();
  });

  it("doesn't act on a collaborator's heading", () => {
    open();
    const { schema } = editor.state;
    const heading = schema.nodes['heading']!.create({ level: 1 }, schema.text('Theirs'));
    editor.view.dispatch(editor.state.tr.insert(0, heading).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(rename).not.toHaveBeenCalled();
  });

  it('does nothing in a read-only document', () => {
    open();
    editor.setEditable(false);
    editor.commands.insertContent('<h1>Read only</h1>');
    editor.commands.splitBlock();
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('prompting for a name (DSK-209)', () => {
  it('prompts once, after a pause, when there are a few words and no heading', () => {
    vi.useFakeTimers();
    open();
    editor.commands.insertContent('Notes from the call');
    vi.advanceTimersByTime(PROMPT_AFTER_PAUSE_MS - 1);
    expect(toasts()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(toasts().map((t) => t.message)).toEqual(['Give this document a name?']);

    const before = useDocumentNamingStore.getState().titleEditRequest;
    toasts()[0]!.onAction!();
    expect(useDocumentNamingStore.getState().titleEditRequest).toBe(before + 1);

    // From another document, Rename opens nothing.
    usePersistenceStore.setState({ currentDocumentId: 'doc-9' });
    toasts()[0]!.onAction!();
    expect(useDocumentNamingStore.getState().titleEditRequest).toBe(before + 1);
    usePersistenceStore.setState({ currentDocumentId: 'doc-1' });

    editor.commands.insertContent(' and more words');
    vi.advanceTimersByTime(PROMPT_AFTER_PAUSE_MS * 2);
    expect(toasts()).toHaveLength(1);
  });

  it('waits for the document to have an id, and for a few words', () => {
    vi.useFakeTimers();
    open(UNTITLED_DOCUMENT_NAME, null);
    editor.commands.insertContent('Notes from the call');
    vi.advanceTimersByTime(PROMPT_AFTER_PAUSE_MS * 2);
    expect(toasts()).toHaveLength(0);

    usePersistenceStore.setState({ currentDocumentId: 'doc-2' });
    editor.commands.setContent('<p></p>', true);
    editor.commands.insertContent('Hi');
    vi.advanceTimersByTime(PROMPT_AFTER_PAUSE_MS * 2);
    expect(toasts()).toHaveLength(0);
  });

  it('publishes the suggestion for the title surfaces', () => {
    open();
    editor.commands.insertContent('<p>First line here</p>');
    expect(useDocumentNamingStore.getState().suggestion).toBe('First line here');
  });
});
