/**
 * Gallery extension — multiple images laid out as a grid or a row.
 *
 * A `gallery` block holds one-or-more `image` nodes (`content: 'image+'`) with a
 * `layout` attribute (`grid` | `row`). It serializes as
 * `<div data-gallery data-layout><div class="gallery-items"><img>…</div></div>`
 * — the inner `.gallery-items` wrapper (declared in renderHTML and matched by
 * `contentElement` on parse) is where the images live, so the same CSS styles
 * both the live nodeView and the static getHTML output. The Grid/Row toggle is a
 * nodeView-only control bar, never serialized.
 *
 * Inserted via multi-file upload (GalleryUploadButton / the `/gallery` command),
 * which builds the image children from freshly-saved blobs.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import './GalleryExtension.css';

export type GalleryLayout = 'grid' | 'row';

/** One image to place in a gallery (built from an uploaded blob). */
export interface GalleryImage {
  src: string;
  alt?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    gallery: {
      /** Insert a gallery containing the given images. */
      insertGallery: (images: GalleryImage[]) => ReturnType;
      /** Set the layout of the gallery at the selection. */
      setGalleryLayout: (layout: GalleryLayout) => ReturnType;
    };
  }
}

export interface GalleryOptions {
  HTMLAttributes: Record<string, unknown>;
}

function asLayout(value: unknown): GalleryLayout {
  return value === 'row' ? 'row' : 'grid';
}

export const Gallery = Node.create<GalleryOptions>({
  name: 'gallery',
  group: 'block',
  content: 'image+',
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      layout: {
        default: 'grid' as GalleryLayout,
        parseHTML: (el: HTMLElement) => asLayout(el.getAttribute('data-layout')),
        renderHTML: (attrs) => ({ 'data-layout': asLayout(attrs['layout']) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-gallery]', contentElement: 'div.gallery-items' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-gallery': '', class: 'prose-gallery' }),
      ['div', { class: 'gallery-items' }, 0],
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'prose-gallery';
      dom.setAttribute('data-gallery', '');
      dom.setAttribute('data-layout', asLayout(node.attrs['layout']));

      // Grid/Row toggle — chrome, never serialized.
      const controls = document.createElement('div');
      controls.className = 'gallery-controls';
      controls.contentEditable = 'false';

      const setLayout = (layout: GalleryLayout) => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== this.name) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, layout }));
      };

      const layoutButtons = (['grid', 'row'] as GalleryLayout[]).map((layout) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = layout === 'grid' ? 'Grid' : 'Row';
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          setLayout(layout);
        });
        controls.appendChild(b);
        return { layout, el: b };
      });
      const refreshActive = (layout: GalleryLayout) => {
        layoutButtons.forEach(({ layout: l, el }) => el.classList.toggle('is-active', l === layout));
      };
      refreshActive(asLayout(node.attrs['layout']));

      const items = document.createElement('div');
      items.className = 'gallery-items';

      dom.appendChild(controls);
      dom.appendChild(items);

      return {
        dom,
        contentDOM: items,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          const layout = asLayout(updated.attrs['layout']);
          dom.setAttribute('data-layout', layout);
          refreshActive(layout);
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      insertGallery:
        (images) =>
        ({ commands }) => {
          if (!images.length) return false;
          return commands.insertContent({
            type: this.name,
            attrs: { layout: 'grid' },
            content: images.map((img) => ({
              type: 'image',
              attrs: { src: img.src, alt: img.alt ?? null },
            })),
          });
        },
      setGalleryLayout:
        (layout) =>
        ({ state, dispatch }) => {
          const { from } = state.selection;
          // A NodeSelection directly on the gallery.
          const direct = state.doc.nodeAt(from);
          if (direct && direct.type.name === this.name) {
            if (dispatch) {
              dispatch(state.tr.setNodeMarkup(from, undefined, { ...direct.attrs, layout: asLayout(layout) }));
            }
            return true;
          }
          // Or a gallery enclosing the selection (e.g. an image inside it).
          const $from = state.doc.resolve(from);
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === this.name) {
              if (dispatch) {
                dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, layout: asLayout(layout) }));
              }
              return true;
            }
          }
          return false;
        },
    };
  },
});
