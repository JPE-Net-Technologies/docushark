/**
 * Callout extension for Tiptap — admonition blocks (note / tip / warning /
 * danger).
 *
 * A `callout` is a `block+` container (like blockquote) carrying a single
 * `variant` attribute that selects the colour + label. It's a plain
 * structural node: sync `parseHTML`/`renderHTML` round-trip a clean
 * `<div data-callout data-variant="…">`, and all presentation (the coloured
 * left border, tint, and the uppercase variant label) is CSS-only — the label
 * is a `::before` from the stylesheet, never serialized into the document, so
 * `getHTML()` → PDF / MCP / offline stay self-contained without it.
 *
 * No nodeView (no async, no store) — the simplest of the new prose nodes, so it
 * validates the slash/insert + serialization path before the heavier slices.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import './CalloutExtension.css';

export type CalloutVariant = 'note' | 'tip' | 'warning' | 'danger';

const VARIANTS: readonly CalloutVariant[] = ['note', 'tip', 'warning', 'danger'];

/** Coerce an arbitrary attribute value to a known variant (default `note`). */
function asVariant(value: unknown): CalloutVariant {
  return VARIANTS.includes(value as CalloutVariant) ? (value as CalloutVariant) : 'note';
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the selection in a callout, or re-style the current one. */
      setCallout: (variant?: CalloutVariant) => ReturnType;
      /** Toggle a callout wrap around the selection. */
      toggleCallout: (variant?: CalloutVariant) => ReturnType;
      /** Lift the selection out of its callout. */
      unsetCallout: () => ReturnType;
    };
  }
}

export interface CalloutOptions {
  HTMLAttributes: Record<string, unknown>;
}

export const Callout = Node.create<CalloutOptions>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      variant: {
        default: 'note' as CalloutVariant,
        parseHTML: (el: HTMLElement) => asVariant(el.getAttribute('data-variant')),
        renderHTML: (attrs) => ({ 'data-variant': asVariant(attrs['variant']) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-callout': '',
        class: 'callout',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (variant = 'note') =>
        ({ commands, editor }) =>
          // Already in a callout → just change its variant; otherwise wrap.
          editor.isActive(this.name)
            ? commands.updateAttributes(this.name, { variant: asVariant(variant) })
            : commands.wrapIn(this.name, { variant: asVariant(variant) }),
      toggleCallout:
        (variant = 'note') =>
        ({ commands }) =>
          commands.toggleWrap(this.name, { variant: asVariant(variant) }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
