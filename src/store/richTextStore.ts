/**
 * Rich text store for managing document editor content.
 *
 * Stores Tiptap editor content separately from diagram data.
 *
 * WRITE RAIL (JP-198): prose **content** here is a PROJECTION — the editor (and,
 * in collab, the Y.Doc fragment) is the source of truth; this store mirrors it.
 * Content is set ONLY by the editor `onUpdate` mirror (`TiptapEditor` /
 * `CollaborativeProseEditor`) or a load (`persistenceStore` / settings restore).
 * Do NOT write content from anywhere else — metadata like the custom dictionary
 * has its own method (`addDictionaryWord`), so it never rides the content path.
 * Enforced by `proseWriteBoundary.test.ts`.
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
  /**
   * Add a word to the document's custom spellcheck dictionary — metadata, not
   * prose content. A structural merge (dedupe + mark dirty); callers must NOT
   * round-trip through `loadContent` to append a word (that abused the
   * content-write path and once dropped the dictionary — see JP-198 /
   * `proseWriteBoundary.test.ts`).
   */
  addDictionaryWord: (word: string) => void;
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

    // Merge a word into the custom dictionary WITHOUT touching prose content.
    // Guarded read first so a duplicate add doesn't fire a spurious update.
    addDictionaryWord: (word: string) => {
      const current = get().content.customDictionary ?? [];
      if (current.includes(word)) return;
      set((state) => ({
        content: { ...state.content, customDictionary: [...current, word] },
        isDirty: true,
      }));
    },
  })
);

/**
 * Get the current rich text content for saving.
 */
export function getRichTextContent(): RichTextContent {
  return useRichTextStore.getState().getContent();
}
