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
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
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
      /** Reorder the selected gallery image left (-1) or right (+1). */
      moveGalleryImage: (dir: -1 | 1) => ReturnType;
      /** Move the caret from a gallery to a new paragraph after it. */
      exitGallery: () => ReturnType;
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
              // Start as a thumbnail (still resizable) so a fresh gallery isn't a
              // stack of full-size images.
              attrs: { src: img.src, alt: img.alt ?? null, width: 220 },
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
      moveGalleryImage:
        (dir) =>
        ({ state, dispatch }) => {
          const sel = state.selection;
          if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return false;
          const $from = state.doc.resolve(sel.from);
          if ($from.parent.type.name !== this.name) return false; // not in a gallery
          const gallery = $from.parent;
          const index = $from.index();
          const target = index + dir;
          if (target < 0 || target >= gallery.childCount) return false; // at an edge

          if (dispatch) {
            const galleryStart = $from.before($from.depth);
            const children: PMNode[] = [];
            gallery.forEach((child) => children.push(child));
            const [moved] = children.splice(index, 1);
            children.splice(target, 0, moved!);
            const newGallery = gallery.copy(Fragment.fromArray(children));
            const tr = state.tr.replaceWith(galleryStart, galleryStart + gallery.nodeSize, newGallery);
            // Re-select the moved image (all gallery children are size-1 atoms).
            tr.setSelection(NodeSelection.create(tr.doc, galleryStart + 1 + target));
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
      exitGallery:
        () =>
        ({ state, dispatch }) => {
          const $from = state.doc.resolve(state.selection.from);
          let depth = $from.depth;
          while (depth > 0 && $from.node(depth).type.name !== this.name) depth--;
          if (depth === 0) return false; // not in a gallery

          const afterGallery = $from.after(depth);
          const para = state.schema.nodes['paragraph']?.createAndFill();
          if (!para) return false;
          if (dispatch) {
            const tr = state.tr.insert(afterGallery, para);
            tr.setSelection(TextSelection.near(tr.doc.resolve(afterGallery + 1), 1)).scrollIntoView();
            dispatch(tr);
          }
          return true;
        },
    };
  },

  // Arrow keys reorder the selected gallery image; Enter exits to a paragraph
  // below the gallery. All return false when not applicable, so normal
  // navigation / Enter behaviour is unaffected elsewhere.
  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => this.editor.commands.moveGalleryImage(-1),
      ArrowRight: () => this.editor.commands.moveGalleryImage(1),
      Enter: () => this.editor.commands.exitGallery(),
    };
  },
});
