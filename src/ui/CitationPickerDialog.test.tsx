/**
 * Tests for CitationPickerDialog (JP-89 slice 5).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CitationInline, Bibliography } from '../tiptap/CitationExtension';
import { CitationPickerDialog } from './CitationPickerDialog';
import { useReferenceStore } from '../store/referenceStore';

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ history: false }), CitationInline, Bibliography],
    content: '<p></p>',
  });
}

beforeEach(() => useReferenceStore.getState().clear());

describe('CitationPickerDialog', () => {
  it('lists references and inserts the chosen one', () => {
    useReferenceStore
      .getState()
      .addReference({ id: 'smith2020', type: 'article-journal', title: 'On Things', author: [{ family: 'Smith' }] });
    const editor = makeEditor();
    const onClose = vi.fn();

    render(<CitationPickerDialog editor={editor} onClose={onClose} onManageReferences={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Smith/ }));

    expect(editor.getHTML()).toContain('data-ref-id="smith2020"');
    expect(onClose).toHaveBeenCalled();

    editor.destroy();
  });

  it('passes a locator through to the citation', () => {
    useReferenceStore.getState().addReference({ id: 'doe2019', type: 'book', author: [{ family: 'Doe' }] });
    const editor = makeEditor();

    render(<CitationPickerDialog editor={editor} onClose={vi.fn()} onManageReferences={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Locator (optional)'), { target: { value: 'p. 42' } });
    fireEvent.click(screen.getByRole('button', { name: /Doe/ }));

    expect(editor.getHTML()).toContain('data-locator="p. 42"');
    editor.destroy();
  });

  it('shows an empty state that opens the reference manager', () => {
    const editor = makeEditor();
    const onClose = vi.fn();
    const onManage = vi.fn();

    render(<CitationPickerDialog editor={editor} onClose={onClose} onManageReferences={onManage} />);

    expect(screen.getByText('No references yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add references…' }));
    expect(onClose).toHaveBeenCalled();
    expect(onManage).toHaveBeenCalled();

    editor.destroy();
  });
});
