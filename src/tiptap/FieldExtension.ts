/**
 * FieldRef extension for Tiptap (Phase 3 — Document Fields).
 *
 * An inline atom holding a field `name`, rendered live as that field's current
 * value from `fieldStore` (or a built-in computed value like `today` / `now`).
 * Edit the value once in the Fields manager and every `{{name}}` reference
 * repaints. Modelled almost 1:1 on `CitationInline`: an atom node + a
 * store-reactive `nodeView` that caches the resolved value back into the node's
 * `label` attribute (the "projection") so non-editor consumers (getHTML → PDF /
 * MCP / offline) are self-contained.
 *
 * Serialization is the **MCP wire contract**: a `<span data-field
 * data-name="NAME" data-label="VALUE">`. `parseHTML` keys off `data-field` and
 * reads `data-name`; `data-label` is **optional** (the nodeView fills it live),
 * so a future Markdown→HTML adapter can emit `{{name}}` → `<span data-field
 * data-name="name">` with no label and the editor resolves it.
 *
 * v1 is client-side only — there is no relay/MCP write path for field values
 * yet (the Fields manager surfaces this). The data model is kept forward-
 * compatible so that work is purely additive.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { useFieldStore } from '../store/fieldStore';
import { getComputedField } from '../types/Field';
import { PROSE_PROJECTION_META } from './proseProjection';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fieldRef: {
      /** Insert an inline field reference to `{{name}}`. */
      setFieldRef: (name: string) => ReturnType;
    };
  }
}

export interface FieldOptions {
  HTMLAttributes: Record<string, unknown>;
}

/**
 * Resolve a field name to its display value: a computed field's live value, or
 * the user field's stored value. `undefined` when the name is unknown / unset.
 */
export function resolveFieldValue(name: string): string | undefined {
  const computed = getComputedField(name);
  if (computed) return computed.resolve();
  return useFieldStore.getState().getField(name)?.value;
}

/**
 * Inline field node — `{{name}}` rendered as the field's current value.
 */
export const FieldRef = Node.create<FieldOptions>({
  name: 'fieldRef',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  // Each attribute owns its `data-*` serialization (parse + render) so getHTML
  // emits ONLY clean `data-*` attributes — the robust round-trip shape (same as
  // CitationInline). `data-label` is the cached projection; it is optional on
  // parse so an MCP-emitted `{{name}}`→span with no label still resolves live.
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-name') ?? '',
        renderHTML: (attrs) => (attrs['name'] ? { 'data-name': String(attrs['name']) } : {}),
      },
      // Cached resolved value (the "projection"): renderHTML is the source of
      // truth for static HTML consumers, while the nodeView re-derives it live.
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => (attrs['label'] ? { 'data-label': String(attrs['label']) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-field]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs['label'] as string) ?? '';
    // Emit the cached label as the text child too, so static HTML consumers show
    // it; the editor re-derives it live. `data-*` attrs come from addAttributes.
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-field': '',
        class: 'field-ref',
      }),
      label,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.setAttribute('data-field', '');
      dom.className = 'field-ref';
      dom.contentEditable = 'false';

      let name = node.attrs['name'] as string;
      // The last user value we resolved against, so the store subscription only
      // re-renders when *this* field's value actually changes (loop-safe, cheap).
      let lastUserValue = useFieldStore.getState().getField(name)?.value;

      // Persist the resolved value into the node's `label` attr so the HTML
      // projection (getHTML → PDF / MCP / offline) is self-contained. Same
      // safety as CitationInline: idempotent, editable-only, out of undo, runs
      // post-update, re-checks position + type + name before dispatch.
      const writeBackLabel = (label: string) => {
        if (!editor.isEditable) return; // view-only clients never dirty the doc
        if (isAutoSaveSuppressed()) return; // never dispatch during load/new/switch
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== this.name || cur.attrs['name'] !== name) return;
        if (cur.attrs['label'] === label) return; // idempotent → loop-safe
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, label });
        tr.setMeta('addToHistory', false); // keep label-sync out of undo
        tr.setMeta(PROSE_PROJECTION_META, true); // derived write → mirror silently, no autosave
        editor.view.dispatch(tr);
      };

      const render = () => {
        const value = resolveFieldValue(name);
        if (value && value.length > 0) {
          dom.textContent = value;
          dom.classList.remove('field-ref-unset');
          dom.title = getComputedField(name) ? `Computed field: ${name}` : name;
          writeBackLabel(value);
        } else {
          // Unset / empty → a muted `{name}` placeholder so the field is visibly
          // actionable. Never cache a placeholder as the label (not a real value).
          dom.textContent = `{${name}}`;
          dom.classList.add('field-ref-unset');
          dom.title = getComputedField(name) ? `Computed field: ${name}` : `Field "${name}" has no value yet`;
        }
      };

      render();

      const unsubscribe = useFieldStore.subscribe((state) => {
        const next = state.getField(name)?.value;
        if (next !== lastUserValue) {
          lastUserValue = next;
          render();
        }
      });

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== this.name) return false;
          const newName = updatedNode.attrs['name'] as string;
          if (newName !== name) {
            name = newName;
            lastUserValue = useFieldStore.getState().getField(name)?.value;
            render();
          }
          return true;
        },
        destroy: () => {
          unsubscribe();
        },
      };
    };
  },

  addCommands() {
    return {
      setFieldRef:
        (name: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { name } }),
    };
  },
});
