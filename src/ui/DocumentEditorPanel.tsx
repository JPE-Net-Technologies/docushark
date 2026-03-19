/**
 * DocumentEditorPanel - Container panel for the rich text editor.
 *
 * Contains:
 * - Header with title and collapse button
 * - Tab bar for multi-page support
 * - Formatting toolbar
 * - Tiptap editor
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { DocumentEditorToolbar } from './DocumentEditorToolbar';
import { TiptapEditor } from './TiptapEditor';
import { TiptapEditorProvider } from './TiptapEditorContext';
import { RichTextTabBar } from './RichTextTabBar';
import { useRichTextPagesStore, initializeRichTextPages } from '../store/richTextPagesStore';
import './DocumentEditorPanel.css';

export interface DocumentEditorPanelProps {
  /** Optional callback when collapse button is clicked */
  onCollapse?: () => void;
  /** Whether the editor is in full-screen mode */
  isFullscreen?: boolean;
  /** Toggle full-screen mode */
  onToggleFullscreen?: () => void;
}

export function DocumentEditorPanel({ onCollapse, isFullscreen, onToggleFullscreen }: DocumentEditorPanelProps) {
  const { activePageId, pages, updatePageContent } = useRichTextPagesStore();
  const lastActivePageRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);

  // Keep ref in sync for use in effects/callbacks that shouldn't re-trigger
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Initialize pages on mount
  useEffect(() => {
    initializeRichTextPages();
  }, []);

  // Handle editor ready callback from TiptapEditor
  const handleEditorReady = useCallback((ed: Editor | null) => {
    setEditor(ed);
    // Also keep window global for PDFExportDialog (non-component context)
    if (ed) {
      (window as unknown as { __tiptapEditor?: Editor }).__tiptapEditor = ed;
    } else {
      delete (window as unknown as { __tiptapEditor?: Editor }).__tiptapEditor;
    }
  }, []);

  // Handle page switching - save current content and load new page content
  useEffect(() => {
    if (!editor || !activePageId) return;

    // If this is the first load or same page, skip
    if (lastActivePageRef.current === activePageId) return;

    // Save current page content before switching
    if (lastActivePageRef.current && !isLoadingRef.current) {
      const currentContent = editor.getHTML();
      updatePageContent(lastActivePageRef.current, currentContent);
    }

    // Load new page content
    isLoadingRef.current = true;
    const newPage = pages[activePageId];
    if (newPage) {
      // Use setTimeout to ensure editor is ready
      setTimeout(() => {
        if (editorRef.current) {
          editorRef.current.commands.setContent(newPage.content || '<p></p>');
        }
        isLoadingRef.current = false;
      }, 0);
    }

    lastActivePageRef.current = activePageId;
  }, [activePageId, pages, updatePageContent, editor]);

  // Auto-save current page content periodically
  useEffect(() => {
    const saveInterval = setInterval(() => {
      const pageId = useRichTextPagesStore.getState().activePageId;
      if (editorRef.current && pageId && !isLoadingRef.current) {
        const content = editorRef.current.getHTML();
        updatePageContent(pageId, content);
      }
    }, 5000);

    return () => clearInterval(saveInterval);
  }, [updatePageContent]);

  // Save on unmount
  useEffect(() => {
    return () => {
      const pageId = useRichTextPagesStore.getState().activePageId;
      if (editorRef.current && pageId) {
        const content = editorRef.current.getHTML();
        updatePageContent(pageId, content);
      }
    };
  }, [updatePageContent]);

  // Exit full-screen on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen && onToggleFullscreen) {
        onToggleFullscreen();
      }
    },
    [isFullscreen, onToggleFullscreen]
  );

  useEffect(() => {
    if (!isFullscreen) return;
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, handleKeyDown]);

  return (
    <TiptapEditorProvider value={editor}>
      <div className={`document-editor-panel ${isFullscreen ? 'fullscreen' : ''}`}>
        <div className="document-editor-panel-header">
          <span className="document-editor-panel-title">Document</span>
          <div className="document-editor-panel-actions">
            {onToggleFullscreen && (
              <button
                className="document-editor-panel-collapse"
                onClick={onToggleFullscreen}
                title={isFullscreen ? 'Exit full-screen (Esc)' : 'Full-screen editor'}
              >
                {isFullscreen ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M5.5 1a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1H5V1.5a.5.5 0 0 1 .5-.5zm5 0a.5.5 0 0 1 .5.5V4h2.5a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5zM2 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0V11H2.5a.5.5 0 0 1-.5-.5zm8 0a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1H11v2.5a.5.5 0 0 1-1 0v-3z" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.5 1a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 1 0V2h2.5a.5.5 0 0 0 0-1h-3zm11 0a.5.5 0 0 0 0 1H15v2.5a.5.5 0 0 0 1 0v-3a.5.5 0 0 0-.5-.5h-3zM.5 11a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 0-1H1v-2.5a.5.5 0 0 0-1 0zm15 0a.5.5 0 0 0-1 0V14h-2.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 .5-.5v-3z" />
                  </svg>
                )}
              </button>
            )}
            {onCollapse && !isFullscreen && (
              <button
                className="document-editor-panel-collapse"
                onClick={onCollapse}
                title="Hide document editor"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <RichTextTabBar />
        <DocumentEditorToolbar />
        <div className="document-editor-panel-content">
          <TiptapEditor onEditorReady={handleEditorReady} />
        </div>
      </div>
    </TiptapEditorProvider>
  );
}
