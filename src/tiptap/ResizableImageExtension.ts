/**
 * Resizable Image extension for Tiptap.
 *
 * Extends the default Image extension with:
 * - Resize handles (corners and edges)
 * - Aspect ratio preservation (optional, default on)
 * - Width/height stored in attributes
 * - Float / text-wrap (left | right | none) so prose wraps around the image
 */

import { Node, mergeAttributes } from '@tiptap/core';
import './ResizableImageExtension.css';

/** Float / text-wrap mode. `null` = block image (no wrap), the default. */
export type ImageFloat = 'left' | 'right' | null;

export interface ResizableImageOptions {
  inline: boolean;
  allowBase64: boolean;
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    resizableImage: {
      setImage: (options: {
        src: string;
        alt?: string;
        title?: string;
        width?: number;
        height?: number;
      }) => ReturnType;
      /** Set float/text-wrap on the currently selected image. */
      setImageFloat: (float: ImageFloat) => ReturnType;
    };
  }
}

export const ResizableImage = Node.create<ResizableImageOptions>({
  name: 'image',
  group: 'block',
  draggable: true,
  atom: true,

  addOptions() {
    return {
      inline: false,
      allowBase64: true,
      HTMLAttributes: {
        class: 'tiptap-image',
      },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
      },
      alt: {
        default: null,
      },
      title: {
        default: null,
      },
      width: {
        default: null,
      },
      height: {
        default: null,
      },
      float: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-float');
          return v === 'left' || v === 'right' ? v : null;
        },
        renderHTML: (attrs) => (attrs['float'] ? { 'data-float': String(attrs['float']) } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const container = document.createElement('div');
      container.classList.add('resizable-image-container');

      const img = document.createElement('img');
      img.src = node.attrs['src'] as string;
      if (node.attrs['alt']) img.alt = node.attrs['alt'] as string;
      if (node.attrs['title']) img.title = node.attrs['title'] as string;
      if (node.attrs['width']) img.style.width = `${node.attrs['width']}px`;
      if (node.attrs['height']) img.style.height = `${node.attrs['height']}px`;
      img.classList.add('tiptap-image');

      // Create resize handles
      const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'];
      const handleElements: HTMLDivElement[] = [];

      handles.forEach((pos) => {
        const handle = document.createElement('div');
        handle.classList.add('resize-handle', `resize-handle-${pos}`);
        handle.dataset['handle'] = pos;
        handleElements.push(handle);
        container.appendChild(handle);
      });

      container.appendChild(img);

      // Apply the current float/text-wrap to the container (the block in flow,
      // so prose wraps around it). `data-float` drives the CSS.
      const applyFloat = (float: ImageFloat) => {
        if (float) container.setAttribute('data-float', float);
        else container.removeAttribute('data-float');
      };
      applyFloat(node.attrs['float'] as ImageFloat);

      const setFloat = (value: ImageFloat) => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== 'image') return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, float: value }));
      };

      // Float controls (Left / Inline / Right), shown only while selected.
      const controls = document.createElement('div');
      controls.className = 'image-float-controls';
      controls.contentEditable = 'false';
      controls.style.display = 'none';
      const FLOAT_OPTIONS: { value: ImageFloat; label: string; title: string }[] = [
        { value: 'left', label: 'Left', title: 'Float left — wrap text on the right' },
        { value: null, label: 'Inline', title: 'No wrap (block image)' },
        { value: 'right', label: 'Right', title: 'Float right — wrap text on the left' },
      ];
      const floatButtons = FLOAT_OPTIONS.map(({ value, label, title }) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          setFloat(value);
        });
        controls.appendChild(b);
        return { value, el: b };
      });
      const refreshActiveFloat = (float: ImageFloat) => {
        floatButtons.forEach(({ value, el }) => el.classList.toggle('is-active', value === float));
      };
      refreshActiveFloat(node.attrs['float'] as ImageFloat);
      container.appendChild(controls);

      // Handle selection state
      const updateSelection = (selected: boolean) => {
        container.classList.toggle('selected', selected);
        handleElements.forEach((h) => {
          h.style.display = selected ? 'block' : 'none';
        });
        controls.style.display = selected ? 'flex' : 'none';
      };

      // Initially hide handles
      handleElements.forEach((h) => {
        h.style.display = 'none';
      });

      // Click to select
      container.addEventListener('click', (e) => {
        e.stopPropagation();
        updateSelection(true);
      });

      // Deselect on click outside
      const handleClickOutside = (e: MouseEvent) => {
        if (!container.contains(e.target as globalThis.Node)) {
          updateSelection(false);
        }
      };
      document.addEventListener('click', handleClickOutside);

      // Resize logic
      let isResizing = false;
      let startX = 0;
      let startY = 0;
      let startWidth = 0;
      let startHeight = 0;
      let activeHandle = '';
      let aspectRatio = 1;

      const onMouseDown = (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target.classList.contains('resize-handle')) return;

        e.preventDefault();
        e.stopPropagation();

        isResizing = true;
        activeHandle = target.dataset['handle'] ?? '';
        startX = e.clientX;
        startY = e.clientY;
        startWidth = img.offsetWidth;
        startHeight = img.offsetHeight;
        aspectRatio = startWidth / startHeight;

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      };

      const onMouseMove = (e: MouseEvent) => {
        if (!isResizing) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newWidth = startWidth;
        let newHeight = startHeight;

        // Calculate new dimensions based on handle
        const preserveAspect = !e.shiftKey; // Hold shift to free resize

        switch (activeHandle) {
          case 'se':
            newWidth = Math.max(50, startWidth + dx);
            newHeight = preserveAspect
              ? newWidth / aspectRatio
              : Math.max(50, startHeight + dy);
            break;
          case 'sw':
            newWidth = Math.max(50, startWidth - dx);
            newHeight = preserveAspect
              ? newWidth / aspectRatio
              : Math.max(50, startHeight + dy);
            break;
          case 'ne':
            newWidth = Math.max(50, startWidth + dx);
            newHeight = preserveAspect
              ? newWidth / aspectRatio
              : Math.max(50, startHeight - dy);
            break;
          case 'nw':
            newWidth = Math.max(50, startWidth - dx);
            newHeight = preserveAspect
              ? newWidth / aspectRatio
              : Math.max(50, startHeight - dy);
            break;
          case 'e':
            newWidth = Math.max(50, startWidth + dx);
            if (preserveAspect) newHeight = newWidth / aspectRatio;
            break;
          case 'w':
            newWidth = Math.max(50, startWidth - dx);
            if (preserveAspect) newHeight = newWidth / aspectRatio;
            break;
          case 's':
            newHeight = Math.max(50, startHeight + dy);
            if (preserveAspect) newWidth = newHeight * aspectRatio;
            break;
          case 'n':
            newHeight = Math.max(50, startHeight - dy);
            if (preserveAspect) newWidth = newHeight * aspectRatio;
            break;
        }

        img.style.width = `${newWidth}px`;
        img.style.height = `${newHeight}px`;
      };

      const onMouseUp = () => {
        if (!isResizing) return;

        isResizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Update node attributes
        const pos = getPos();
        if (typeof pos === 'number') {
          const newWidth = img.offsetWidth;
          const newHeight = img.offsetHeight;

          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, {
              ...node.attrs,
              width: newWidth,
              height: newHeight,
            })
          );
        }
      };

      container.addEventListener('mousedown', onMouseDown);

      return {
        dom: container,
        update: (updatedNode) => {
          if (updatedNode.type.name !== 'image') return false;

          img.src = updatedNode.attrs['src'] as string;
          if (updatedNode.attrs['alt']) img.alt = updatedNode.attrs['alt'] as string;
          if (updatedNode.attrs['title'])
            img.title = updatedNode.attrs['title'] as string;
          if (updatedNode.attrs['width'])
            img.style.width = `${updatedNode.attrs['width']}px`;
          if (updatedNode.attrs['height'])
            img.style.height = `${updatedNode.attrs['height']}px`;
          applyFloat(updatedNode.attrs['float'] as ImageFloat);
          refreshActiveFloat(updatedNode.attrs['float'] as ImageFloat);

          return true;
        },
        destroy: () => {
          document.removeEventListener('click', handleClickOutside);
        },
      };
    };
  },

  addCommands() {
    return {
      setImage:
        (options) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
      setImageFloat:
        (float) =>
        ({ state, dispatch }) => {
          // Operate on the image at the selection (a NodeSelection on the image,
          // or the block the caret sits in).
          const { from } = state.selection;
          const node = state.doc.nodeAt(from);
          if (!node || node.type.name !== this.name) return false;
          if (dispatch) dispatch(state.tr.setNodeMarkup(from, undefined, { ...node.attrs, float }));
          return true;
        },
    };
  },
});
