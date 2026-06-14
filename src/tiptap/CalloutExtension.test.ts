/**
 * Tests for the Callout node. Headless via `new Editor` in jsdom (same pattern
 * as CitationExtension.test.ts). Covers the sync schema round-trip
 * (renderHTML/parseHTML) and the wrap/re-style/lift commands.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Callout } from './CalloutExtension';

const extensions = [StarterKit.configure({ history: false }), Callout];

function makeEditor(content = '<p>Hello world</p>'): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

/** Count occurrences of `data-callout` in the serialized HTML. */
function calloutCount(html: string): number {
  return html.split('data-callout').length - 1;
}

describe('callout schema round-trip', () => {
  it('setCallout wraps the block in a callout with the default variant', () => {
    const { editor, element } = makeEditor();
    editor.commands.setCallout();

    const html = editor.getHTML();
    expect(html).toContain('data-callout');
    expect(html).toContain('data-variant="note"');
    expect(html).toContain('Hello world');

    editor.destroy();
    element.remove();
  });

  it('emits the chosen variant', () => {
    const { editor, element } = makeEditor();
    editor.commands.setCallout('warning');
    expect(editor.getHTML()).toContain('data-variant="warning"');
    editor.destroy();
    element.remove();
  });

  it('parses callout HTML back into a node, preserving variant + content', () => {
    const { editor, element } = makeEditor();
    editor.commands.setContent('<div data-callout data-variant="danger"><p>Careful</p></div>');

    expect(editor.isActive('callout')).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('data-variant="danger"');
    expect(html).toContain('Careful');

    editor.destroy();
    element.remove();
  });

  it('coerces an unknown variant to note on parse', () => {
    const { editor, element } = makeEditor();
    editor.commands.setContent('<div data-callout data-variant="bogus"><p>x</p></div>');
    expect(editor.getHTML()).toContain('data-variant="note"');
    editor.destroy();
    element.remove();
  });
});

describe('callout commands', () => {
  it('setCallout while inside a callout re-styles it rather than nesting', () => {
    const { editor, element } = makeEditor();
    editor.commands.setCallout('note');
    editor.commands.setCallout('danger');

    const html = editor.getHTML();
    expect(calloutCount(html)).toBe(1); // not nested
    expect(html).toContain('data-variant="danger"');

    editor.destroy();
    element.remove();
  });

  it('unsetCallout lifts the content back out', () => {
    const { editor, element } = makeEditor();
    editor.commands.setCallout('tip');
    expect(editor.isActive('callout')).toBe(true);

    editor.commands.unsetCallout();
    expect(editor.isActive('callout')).toBe(false);
    expect(editor.getHTML()).not.toContain('data-callout');

    editor.destroy();
    element.remove();
  });
});
