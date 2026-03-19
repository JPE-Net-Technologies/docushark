/**
 * TiptapEditorContext - React Context for sharing the Tiptap editor instance.
 *
 * Replaces the previous window.__tiptapEditor global + polling pattern.
 * Provides the editor instance to toolbar, image upload, and other consumers.
 */

import { createContext, useContext } from 'react';
import type { Editor } from '@tiptap/core';

const TiptapEditorContext = createContext<Editor | null>(null);

/**
 * Hook to access the current Tiptap editor instance.
 * Returns null if editor is not yet initialized.
 */
export function useTiptapEditor(): Editor | null {
  return useContext(TiptapEditorContext);
}

export const TiptapEditorProvider = TiptapEditorContext.Provider;
