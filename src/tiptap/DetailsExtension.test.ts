/**
 * Tests for the Details (collapsible toggle) nodes. Headless via `new Editor`
 * in jsdom (same pattern as CalloutExtension.test.ts). Covers the sync schema
 * round-trip and the open/close attribute.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Details, DetailsSummary, DetailsContent } from './DetailsExtension';

const extensions = [StarterKit.configure({ history: false }), Details, DetailsSummary, DetailsContent];

function makeEditor(content = '<p></p>'): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

const DETAILS_HTML =
  '<div data-details data-open="true"><div data-details-summary>Title</div><div data-details-content><p>body text</p></div></div>';

describe('details schema round-trip', () => {
  it('insertDetails creates an open section with a summary + body', () => {
    const { editor, element } = makeEditor();
    editor.commands.insertDetails();

    const html = editor.getHTML();
    expect(html).toContain('data-details');
    expect(html).toContain('data-open="true"');
    expect(html).toContain('data-details-summary');
    expect(html).toContain('data-details-content');
    expect(html).toContain('Toggle'); // seeded summary text

    editor.destroy();
    element.remove();
  });

  it('round-trips the summary + content from HTML', () => {
    const { editor, element } = makeEditor(DETAILS_HTML);
    const html = editor.getHTML();
    expect(html).toContain('data-details-summary');
    expect(html).toContain('Title');
    expect(html).toContain('body text');
    expect(html).toContain('data-open="true"');

    editor.destroy();
    element.remove();
  });

  it('preserves a closed (data-open="false") section', () => {
    const { editor, element } = makeEditor(DETAILS_HTML.replace('data-open="true"', 'data-open="false"'));
    expect(editor.getHTML()).toContain('data-open="false"');
    editor.destroy();
    element.remove();
  });
});

describe('details open/close', () => {
  it('toggleDetailsOpen flips the open attribute when the selection is inside', () => {
    const { editor, element } = makeEditor(DETAILS_HTML);
    // Place the caret inside the summary text ("Title").
    editor.commands.setTextSelection(3);
    expect(editor.getHTML()).toContain('data-open="true"');

    const toggled = editor.commands.toggleDetailsOpen();
    expect(toggled).toBe(true);
    expect(editor.getHTML()).toContain('data-open="false"');

    editor.destroy();
    element.remove();
  });
});

describe('details summary Enter', () => {
  it('exitSummaryToContent moves the caret from the summary into the body', () => {
    const { editor, element } = makeEditor(DETAILS_HTML);
    editor.commands.setTextSelection(3); // inside the summary ("Title")
    expect(editor.state.selection.$from.parent.type.name).toBe('detailsSummary');

    const moved = editor.commands.exitSummaryToContent();
    expect(moved).toBe(true);

    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('paragraph');
    expect($from.node($from.depth - 1).type.name).toBe('detailsContent');

    editor.destroy();
    element.remove();
  });

  it('exitSummaryToContent is a no-op when the caret is already in the body', () => {
    const { editor, element } = makeEditor(DETAILS_HTML);
    editor.commands.setTextSelection(12); // inside the body paragraph
    expect(editor.commands.exitSummaryToContent()).toBe(false);
    editor.destroy();
    element.remove();
  });
});
