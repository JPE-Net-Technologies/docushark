/**
 * Tests for the Figure (image + caption) nodes. Headless `new Editor` in jsdom
 * (same pattern as CalloutExtension.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ResizableImage } from './ResizableImageExtension';
import { Figure, Figcaption } from './FigureExtension';

const extensions = [StarterKit.configure({ history: false }), ResizableImage, Figure, Figcaption];

function makeEditor(content: string): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

describe('figure schema round-trip', () => {
  it('round-trips a figure with a caption from HTML', () => {
    const { editor, element } = makeEditor(
      '<figure><img src="blob://x" alt="x"><figcaption>A caption</figcaption></figure>'
    );
    const html = editor.getHTML();
    expect(html).toContain('<figure');
    expect(html).toContain('<figcaption');
    expect(html).toContain('A caption');
    expect(html).toContain('blob://x');

    editor.destroy();
    element.remove();
  });
});

describe('toggleImageFigure', () => {
  it('wraps a selected image in a figure + caption', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x">');
    editor.commands.setNodeSelection(0);

    expect(editor.commands.toggleImageFigure()).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('<figure');
    expect(html).toContain('<figcaption');
    expect(html).toContain('blob://x');

    editor.destroy();
    element.remove();
  });

  it('unwraps an image already inside a figure', () => {
    const { editor, element } = makeEditor(
      '<figure><img src="blob://x" alt="x"><figcaption>cap</figcaption></figure>'
    );
    // The image sits at pos 1 (inside the figure at pos 0).
    editor.commands.setNodeSelection(1);

    expect(editor.commands.toggleImageFigure()).toBe(true);
    const html = editor.getHTML();
    expect(html).not.toContain('<figure');
    expect(html).not.toContain('<figcaption');
    expect(html).toContain('blob://x');

    editor.destroy();
    element.remove();
  });

  it('is a no-op when no image is selected', () => {
    const { editor, element } = makeEditor('<p>just text</p>');
    expect(editor.commands.toggleImageFigure()).toBe(false);
    editor.destroy();
    element.remove();
  });

  it('clears the image float when wrapping (figures are block/centered)', () => {
    const { editor, element } = makeEditor('<img src="blob://x" alt="x" data-float="left">');
    editor.commands.setNodeSelection(0);
    editor.commands.toggleImageFigure();
    const html = editor.getHTML();
    expect(html).toContain('<figure');
    expect(html).not.toContain('data-float');

    editor.destroy();
    element.remove();
  });
});
