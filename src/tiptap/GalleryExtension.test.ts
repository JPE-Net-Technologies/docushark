/**
 * Tests for the Gallery node. Headless `new Editor` in jsdom (same pattern as
 * CalloutExtension.test.ts). Covers serialization, insertGallery, layout.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ResizableImage } from './ResizableImageExtension';
import { Gallery } from './GalleryExtension';

const extensions = [StarterKit.configure({ history: false }), ResizableImage, Gallery];

function makeEditor(content: string): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content });
  return { editor, element };
}

describe('gallery serialization', () => {
  it('round-trips a gallery (layout + images) from HTML', () => {
    const { editor, element } = makeEditor(
      '<div data-gallery data-layout="row"><div class="gallery-items"><img src="blob://a"><img src="blob://b"></div></div>'
    );
    const html = editor.getHTML();
    expect(html).toContain('data-gallery');
    expect(html).toContain('data-layout="row"');
    expect(html).toContain('gallery-items');
    expect(html).toContain('blob://a');
    expect(html).toContain('blob://b');

    editor.destroy();
    element.remove();
  });
});

describe('insertGallery', () => {
  it('inserts a grid gallery from a list of images', () => {
    const { editor, element } = makeEditor('<p></p>');
    editor.commands.insertGallery([{ src: 'blob://a', alt: 'a' }, { src: 'blob://b' }]);

    const html = editor.getHTML();
    expect(html).toContain('data-gallery');
    expect(html).toContain('data-layout="grid"');
    expect(html).toContain('blob://a');
    expect(html).toContain('blob://b');

    editor.destroy();
    element.remove();
  });

  it('is a no-op with no images', () => {
    const { editor, element } = makeEditor('<p></p>');
    expect(editor.commands.insertGallery([])).toBe(false);
    editor.destroy();
    element.remove();
  });
});

describe('setGalleryLayout', () => {
  it('changes the layout of the selected gallery', () => {
    const { editor, element } = makeEditor(
      '<div data-gallery data-layout="grid"><div class="gallery-items"><img src="blob://a"></div></div>'
    );
    editor.commands.setNodeSelection(0); // the gallery block

    expect(editor.commands.setGalleryLayout('row')).toBe(true);
    expect(editor.getHTML()).toContain('data-layout="row"');

    editor.destroy();
    element.remove();
  });

  it('is a no-op when no gallery is at the selection', () => {
    const { editor, element } = makeEditor('<p>text</p>');
    expect(editor.commands.setGalleryLayout('row')).toBe(false);
    editor.destroy();
    element.remove();
  });
});
