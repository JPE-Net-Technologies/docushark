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

const TWO = '<div data-gallery data-layout="grid"><div class="gallery-items"><img src="blob://a"><img src="blob://b"></div></div>';
const ONE = '<div data-gallery data-layout="grid"><div class="gallery-items"><img src="blob://a"></div></div>';

describe('moveGalleryImage', () => {
  it('reorders the selected image', () => {
    const { editor, element } = makeEditor(TWO);
    editor.commands.setNodeSelection(1); // image "a" (index 0)
    expect(editor.commands.moveGalleryImage(1)).toBe(true);
    const html = editor.getHTML();
    expect(html.indexOf('blob://b')).toBeLessThan(html.indexOf('blob://a'));
    editor.destroy();
    element.remove();
  });

  it('is a no-op at the edge', () => {
    const { editor, element } = makeEditor(TWO);
    editor.commands.setNodeSelection(1); // index 0 → can't move left
    expect(editor.commands.moveGalleryImage(-1)).toBe(false);
    editor.destroy();
    element.remove();
  });
});

describe('exitGallery', () => {
  it('moves the caret to a new paragraph after the gallery', () => {
    const { editor, element } = makeEditor(ONE);
    editor.commands.setNodeSelection(1); // the image in the gallery
    expect(editor.commands.exitGallery()).toBe(true);
    const { $from } = editor.state.selection;
    expect($from.parent.type.name).toBe('paragraph');
    expect($from.depth).toBe(1);
    editor.destroy();
    element.remove();
  });
});

describe('removeSelectedImage (gallery)', () => {
  it('removes a non-last image but keeps the gallery', () => {
    const { editor, element } = makeEditor(TWO);
    editor.commands.setNodeSelection(1); // image "a"
    expect(editor.commands.removeSelectedImage()).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('data-gallery');
    expect(html).not.toContain('blob://a');
    expect(html).toContain('blob://b');
    editor.destroy();
    element.remove();
  });

  it('removes the whole gallery when deleting the last image', () => {
    const { editor, element } = makeEditor(ONE);
    editor.commands.setNodeSelection(1);
    expect(editor.commands.removeSelectedImage()).toBe(true);
    expect(editor.getHTML()).not.toContain('data-gallery');
    editor.destroy();
    element.remove();
  });
});
