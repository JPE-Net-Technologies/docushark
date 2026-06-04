/**
 * Rich text store for managing document editor content.
 *
 * Stores Tiptap editor content separately from diagram data.
 */

import { create } from 'zustand';
import type { JSONContent } from '@tiptap/core';
import {
  RichTextContent,
  createEmptyRichTextContent,
  RICH_TEXT_VERSION,
} from '../types/RichText';

/**
 * Rich text state.
 */
export interface RichTextState {
  /** Current editor content */
  content: RichTextContent;
  /** Whether content has unsaved changes */
  isDirty: boolean;
}

/**
 * Rich text actions.
 */
export interface RichTextActions {
  /** Set the editor content (from Tiptap updates) */
  setContent: (content: JSONContent) => void;
  /** Load content from a saved document */
  loadContent: (content: RichTextContent | null | undefined) => void;
  /** Get current content for saving */
  getContent: () => RichTextContent;
  /** Mark as dirty (has unsaved changes) */
  markDirty: () => void;
  /** Clear dirty flag (after save) */
  clearDirty: () => void;
  /** Reset to empty content */
  reset: () => void;
}

/**
 * Initial state.
 */
const initialState: RichTextState = {
  content: createEmptyRichTextContent(),
  isDirty: false,
};

/**
 * Rich text store for document editor.
 *
 * Usage:
 * ```typescript
 * const { content, setContent, isDirty } = useRichTextStore();
 *
 * // In Tiptap editor onUpdate callback
 * editor.on('update', ({ editor }) => {
 *   setContent(editor.getJSON());
 * });
 *
 * // Load content when document is opened
 * loadContent(document.richTextContent);
 * ```
 */
export const useRichTextStore = create<RichTextState & RichTextActions>()(
  (set, get) => ({
    // State
    ...initialState,

    // Set content from editor updates. Preserve sibling fields on the current
    // content (notably `customDictionary`) — an editor `onUpdate` only carries
    // the Tiptap JSON, so replacing `content` wholesale here would wipe words
    // the user has 'Added to Dictionary' on the very next keystroke.
    setContent: (content: JSONContent) => {
      set((state) => ({
        content: {
          ...state.content,
          content,
          version: RICH_TEXT_VERSION,
        },
        isDirty: true,
      }));
    },

    // Load content from saved document
    loadContent: (content: RichTextContent | null | undefined) => {
      set({
        content: content ?? createEmptyRichTextContent(),
        isDirty: false,
      });
    },

    // Get content for saving
    getContent: () => {
      return get().content;
    },

    // Mark as dirty
    markDirty: () => {
      set({ isDirty: true });
    },

    // Clear dirty flag
    clearDirty: () => {
      set({ isDirty: false });
    },

    // Reset to empty
    reset: () => {
      set(initialState);
    },
  })
);

/**
 * Get the current rich text content for saving.
 */
export function getRichTextContent(): RichTextContent {
  return useRichTextStore.getState().getContent();
}
