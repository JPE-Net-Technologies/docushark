/**
 * Tests for the image float / text-wrap attribute. Headless `new Editor` in
 * jsdom (same pattern as CalloutExtension.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ResizableImage } from './ResizableImageExtension';

const extensions = [StarterKit.configure({ history: false }), ResizableImage];

function makeEditor(content: string): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

describe('image float', () => {
  it('round-trips data-float from HTML', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x" data-float="left">');
    expect(editor.getHTML()).toContain('data-float="left"');
    editor.destroy();
    element.remove();
  });

  it('has no data-float by default', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x">');
    expect(editor.getHTML()).not.toContain('data-float');
    editor.destroy();
    element.remove();
  });

  it('ignores an invalid data-float value', () => {
    const { editor, element } = makeEditor('<img src="blob://x" data-float="bogus">');
    expect(editor.getHTML()).not.toContain('data-float');
    editor.destroy();
    element.remove();
  });

  it('setImageFloat sets and clears float on the selected image', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x">');
    editor.commands.setNodeSelection(0);

    expect(editor.commands.setImageFloat('right')).toBe(true);
    expect(editor.getHTML()).toContain('data-float="right"');

    editor.commands.setImageFloat(null);
    expect(editor.getHTML()).not.toContain('data-float');

    editor.destroy();
    element.remove();
  });

  it('setImageFloat is a no-op when no image is selected', () => {
    const { editor, element } = makeEditor('<p>just text</p>');
    expect(editor.commands.setImageFloat('left')).toBe(false);
    editor.destroy();
    element.remove();
  });

  it('removeSelectedImage deletes a selected (e.g. broken) image', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x">');
    editor.commands.setNodeSelection(0);
    expect(editor.commands.removeSelectedImage()).toBe(true);
    expect(editor.getHTML()).not.toContain('blob://x');
    editor.destroy();
    element.remove();
  });

  it('replaceSelectedImage swaps src/alt in place, keeps float, resets size', () => {
    const { editor, element } = makeEditor('<img src="blob://old" alt="old" data-float="left" width="120" height="80">');
    editor.commands.setNodeSelection(0);

    expect(editor.commands.replaceSelectedImage({ src: 'blob://new', alt: 'new' })).toBe(true);

    const html = editor.getHTML();
    expect(html).toContain('blob://new');
    expect(html).not.toContain('blob://old');
    expect(html).toContain('alt="new"');
    // Float (text-wrap) is a layout choice → preserved across the swap.
    expect(html).toContain('data-float="left"');
    // Old explicit dimensions are dropped so the new image takes natural size.
    expect(html).not.toContain('width="120"');
    expect(html).not.toContain('height="80"');

    editor.destroy();
    element.remove();
  });

  it('replaceSelectedImage is a no-op when no image is selected', () => {
    const { editor, element } = makeEditor('<p>just text</p>');
    expect(editor.commands.replaceSelectedImage({ src: 'blob://new' })).toBe(false);
    editor.destroy();
    element.remove();
  });

  it('preserves float through a resize (regression: resize reset float to inline)', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x">');
    editor.commands.setNodeSelection(0);
    editor.commands.setImageFloat('left');
    expect(editor.getHTML()).toContain('data-float="left"');

    // Drive the nodeView's resize handlers (the stale-closure bug rewrote the
    // node's attrs on mouseup, dropping the float set afterwards).
    const handle = element.querySelector('.resize-handle-se') as HTMLElement;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(editor.getHTML()).toContain('data-float="left"');

    editor.destroy();
    element.remove();
  });
});
