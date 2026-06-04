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
import { EllipsisVertical } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { history } from 'prosemirror-history';
import { DocumentEditorToolbar } from './DocumentEditorToolbar';
import { TiptapEditor } from './TiptapEditor';
import { TiptapEditorProvider } from './TiptapEditorContext';
import { RichTextTabBar } from './RichTextTabBar';
import { useRichTextPagesStore, initializeRichTextPages } from '../store/richTextPagesStore';
import { useRichTextStore } from '../store/richTextStore';
import { useSessionStore } from '../store/sessionStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { usePersistenceStore } from '../store/persistenceStore';
import { isCollabProseEnabled } from '../config/featureFlags';
import { CollaborativeProseEditor } from './CollaborativeProseEditor';
import { RICH_TEXT_VERSION } from '../types/RichText';
import './DocumentEditorPanel.css';

export interface DocumentEditorPanelProps {
  /** Optional callback when "Hide editor" is chosen (docked presentation only) */
  onCollapse?: () => void;
  /** Whether the editor is in full-screen mode */
  isFullscreen?: boolean;
  /** Toggle full-screen mode */
  onToggleFullscreen?: () => void;
  /** Open the layout customization settings (overflow menu item) */
  onCustomizeLayout?: () => void;
  /**
   * How the editor presents itself for the active layout. `reading` is the
   * generous centered column used when the editor is the primary region
   * (Relaxed write/split); `docked` is the compact sidebar used elsewhere.
   */
  presentation?: 'reading' | 'docked';
}

export function DocumentEditorPanel({
  onCollapse,
  isFullscreen,
  onToggleFullscreen,
  onCustomizeLayout,
  presentation = 'docked',
}: DocumentEditorPanelProps) {
  const { activePageId, updatePageContent } = useRichTextPagesStore();

  // Collaborative prose (relay docs + `collabProse` flag). When on, the active
  // prose page is edited through a `CollaborativeProseEditor` bound to its
  // Y.XmlFragment; the panel still owns the toolbar + autosave + persistence.
  // `collabMode` is true only when the *currently open* doc is the synced relay
  // doc (so a local doc viewed during a session keeps the local editor).
  const collabActive = useCollaborationStore((s) => s.isActive);
  const collabSynced = useCollaborationStore((s) => s.isSynced);
  // The offline-first engine (JP-108) only exposes the Y.Doc once IndexedDB has
  // loaded; gate on `isIdbSynced` too, or `getYjsDocument()` may not be ready
  // and a too-early mount would seed/clobber against an unsynced fragment.
  const collabIdbSynced = useCollaborationStore((s) => s.isIdbSynced);
  // Bumped per session restart (switchDocument) — keys the editor below so it
  // rebinds to the fresh Y.Doc instead of a destroyed one (the PR #60 lesson).
  const collabSessionEpoch = useCollaborationStore((s) => s.sessionEpoch);
  const collabDocId = useCollaborationStore((s) => s.config?.documentId ?? null);
  const getYjsDocument = useCollaborationStore((s) => s.getYjsDocument);
  const currentDocId = usePersistenceStore((s) => s.currentDocumentId);
  const collabMode =
    isCollabProseEnabled() &&
    collabActive &&
    collabSynced &&
    collabIdbSynced &&
    !!currentDocId &&
    currentDocId === collabDocId;
  const collabYdoc = collabMode ? getYjsDocument()?.getDoc() ?? null : null;

  const lastActivePageRef = useRef<string | null>(null);
  const isLoadingRef = useRef(false);
  /** Set while we're programmatically setting scrollTop (so the scroll listener
   *  doesn't persist transient values to the wrong page key). */
  const restoreInProgressRef = useRef(false);
  const pendingLoadRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);

  // The actual scroll container is `.tiptap-editor` (overflow-y: auto). Tiptap's
  // EditorContent inserts its own wrapper between that div and `view.dom`, so
  // `view.dom.parentElement` is one level too shallow. Walk up until we find the
  // first ancestor whose computed style actually scrolls — that's the element
  // owning the live scrollTop.
  const getScrollEl = useCallback((ed: Editor | null = editorRef.current): HTMLElement | null => {
    const dom = ed?.view.dom as HTMLElement | undefined;
    if (!dom) return null;
    let node: HTMLElement | null = dom.parentElement;
    while (node) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return node;
      node = node.parentElement;
    }
    return null;
  }, []);

  // Keep ref in sync for use in effects/callbacks that shouldn't re-trigger
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Initialize pages on mount
  useEffect(() => {
    initializeRichTextPages();
  }, []);

  /**
   * Wipe Tiptap's undo/redo history without disturbing the current document.
   *
   * Tiptap (via StarterKit's History extension) keeps one shared undo stack
   * for the editor instance. When we swap in a new page's content with
   * `setContent`, that swap itself is recorded as a transaction — so undoing
   * later walks back through old page loads and resurrects content from
   * other pages. Clearing history at every page boundary makes undo/redo a
   * per-page-session operation, which is what users intuitively expect.
   *
   * Implementation: replace the history plugin *instance* in the plugin
   * array, then `reconfigure` the state. ProseMirror's reconfigure preserves
   * plugin state for plugin instances that are unchanged and reinitializes
   * only those that differ — so the history plugin gets a fresh empty stack
   * while @tiptap/react's ReactNodeView tracking plugin (and every other
   * plugin) keeps its state intact. Using `EditorState.create` here instead
   * would reinit *every* plugin and crash mid-render with
   * "curDesc.parent.children is undefined" because ReactNodeView would try
   * to remount synchronously against a partial desc tree.
   */
  const clearTiptapHistory = useCallback((ed: Editor) => {
    const newPlugins = ed.state.plugins.map((p) => {
      const key = (p as unknown as { key?: string }).key;
      return typeof key === 'string' && key.startsWith('history$') ? history() : p;
    });
    ed.view.updateState(ed.state.reconfigure({ plugins: newPlugins }));
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

    // Same page — nothing to do
    if (lastActivePageRef.current === activePageId) return;

    // Cancel any in-flight load from a previous (now-superseded) switch
    if (pendingLoadRef.current !== null) {
      clearTimeout(pendingLoadRef.current);
      pendingLoadRef.current = null;
    }

    // Save the page we are leaving (skip if we were already mid-load)
    if (lastActivePageRef.current && !isLoadingRef.current) {
      const currentContent = editor.getHTML();
      updatePageContent(lastActivePageRef.current, currentContent);
      const el = getScrollEl(editor);
      if (el) {
        useSessionStore.getState().saveEditorScroll(lastActivePageRef.current, el.scrollTop);
      }
    }

    const targetPageId = activePageId;
    isLoadingRef.current = true;
    restoreInProgressRef.current = true;
    lastActivePageRef.current = targetPageId;

    // Collab mode: the CollaborativeProseEditor is keyed by page and bound to
    // the page's Y.XmlFragment, so Yjs (not setContent) drives content. We've
    // already persisted the leaving page above; skip the local content swap.
    if (collabMode) {
      isLoadingRef.current = false;
      restoreInProgressRef.current = false;
      return;
    }

    pendingLoadRef.current = setTimeout(() => {
      pendingLoadRef.current = null;

      // Read the freshest page content from the store, not from a stale closure
      const freshPage = useRichTextPagesStore.getState().pages[targetPageId];
      if (editorRef.current) {
        editorRef.current.commands.setContent(freshPage?.content ?? '<p></p>');
        // Wipe Tiptap's undo stack so the page-load transaction we just
        // dispatched can never be undone — and so undo/redo on this page
        // cannot walk back into transactions from previously-loaded pages.
        // This is the actual fix for the "undo on page 3 starts applying
        // page 1's content" bug.
        clearTiptapHistory(editorRef.current);
        // Keep richTextStore in sync so TiptapEditor's content-watcher
        // never sees a mismatch and overwrites the freshly-loaded page.
        useRichTextStore.getState().loadContent({
          content: editorRef.current.getJSON(),
          version: RICH_TEXT_VERSION,
        });
        // Restore scroll position after layout settles. Tiptap reports `scrollHeight`
        // in stages while it paints, so we retry until the target is reachable —
        // and abort the moment the user scrolls (so we don't fight live input).
        const savedScroll = useSessionStore.getState().getEditorScroll(targetPageId) ?? 0;
        const restoreEl = getScrollEl(editorRef.current);
        const finishRestore = () => {
          restoreInProgressRef.current = false;
        };
        if (!restoreEl) {
          finishRestore();
        } else {
          let attempts = 0;
          let cancelled = false;
          const cancel = () => { cancelled = true; };
          restoreEl.addEventListener('wheel', cancel, { once: true, passive: true });
          restoreEl.addEventListener('touchmove', cancel, { once: true, passive: true });
          restoreEl.addEventListener('keydown', cancel, { once: true });
          const cleanup = () => {
            restoreEl.removeEventListener('wheel', cancel);
            restoreEl.removeEventListener('touchmove', cancel);
            restoreEl.removeEventListener('keydown', cancel);
            finishRestore();
          };
          const tryRestore = () => {
            if (cancelled) {
              cleanup();
              return;
            }
            restoreEl.scrollTop = savedScroll;
            attempts++;
            if (restoreEl.scrollTop < savedScroll - 1 && attempts < 30) {
              requestAnimationFrame(tryRestore);
            } else {
              cleanup();
            }
          };
          requestAnimationFrame(tryRestore);
        }
      }
      isLoadingRef.current = false;
    }, 0);
    // `pages` is intentionally excluded from deps — it is read imperatively
    // inside the timeout to avoid stale closures and spurious re-runs.
  }, [activePageId, updatePageContent, editor, clearTiptapHistory, collabMode]);

  // Continuously persist scroll position of the active page (debounced).
  // Re-attaches whenever the editor instance changes since the scroll container
  // is owned by Tiptap (`editor.view.dom.parentElement`). We resolve the scroll
  // element from the live `editor` argument, not the ref, so the listener
  // attaches reliably on the very first frame the editor is ready.
  useEffect(() => {
    const el = getScrollEl(editor);
    if (!el) return;
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        // Skip writes during page-load/restore so transient scroll events from
        // DOM rebuilds don't get persisted under the new page's key.
        if (isLoadingRef.current || restoreInProgressRef.current) return;
        // CROSS-PAGE GUARD: use lastActivePageRef (the page whose content is
        // actually mounted in the editor right now), not the store's
        // activePageId — the store flips synchronously when the user clicks a
        // tab, but editor content is only swapped after the page-load effect
        // runs. Reading the store here would persist the old page's scroll
        // (or content, in the autosave/unmount handlers below) into the new
        // page's slot.
        const pageId = lastActivePageRef.current;
        if (pageId) {
          useSessionStore.getState().saveEditorScroll(pageId, el.scrollTop);
        }
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [editor, getScrollEl]);

  // Auto-save current page content periodically
  useEffect(() => {
    const saveInterval = setInterval(() => {
      // Use the page whose content is currently mounted in the editor, not the
      // store's activePageId — see cross-page guard comment in the scroll
      // handler above.
      const pageId = lastActivePageRef.current;
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
      // Cancel any pending page load before unmounting
      if (pendingLoadRef.current !== null) {
        clearTimeout(pendingLoadRef.current);
        pendingLoadRef.current = null;
      }
      // Same cross-page guard — write to whichever page is actually mounted.
      // Skip if a page-load is in flight (lastActivePageRef has already been
      // flipped to the target page but its content hasn't been swapped into
      // the editor yet — saving here would write the old page's content
      // into the new page's slot).
      const pageId = lastActivePageRef.current;
      if (editorRef.current && pageId && !isLoadingRef.current) {
        const content = editorRef.current.getHTML();
        updatePageContent(pageId, content);
        const el = getScrollEl(editorRef.current);
        if (el) {
          useSessionStore.getState().saveEditorScroll(pageId, el.scrollTop);
        }
      }
    };
  }, [updatePageContent, getScrollEl]);

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

  // Overflow ("⋮") menu — consolidates the editor's header actions.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  // "Hide editor" only makes sense in the docked sidebar presentation; in the
  // primary reading column the focus switch governs prose vs canvas instead.
  const canHideEditor = !!onCollapse && !isFullscreen && presentation === 'docked';
  const hasMenu = !!onToggleFullscreen || canHideEditor || !!onCustomizeLayout;

  // The overflow ("⋮") menu lives in the page-tab row (there's no separate panel
  // header) so it doesn't cost a dead row of vertical space above the editor.
  const overflowMenu = hasMenu ? (
    <div className="document-editor-panel-actions" ref={menuRef}>
      <button
        className="document-editor-panel-collapse"
        onClick={() => setMenuOpen((v) => !v)}
        title="Editor options"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Editor options"
      >
        <EllipsisVertical size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {menuOpen && (
        <div className="document-editor-panel-menu" role="menu">
          {onToggleFullscreen && (
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onToggleFullscreen();
              }}
            >
              {isFullscreen ? 'Exit full-screen' : 'Full screen'}
            </button>
          )}
          {canHideEditor && (
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onCollapse?.();
              }}
            >
              Hide editor
            </button>
          )}
          {onCustomizeLayout && (
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onCustomizeLayout();
              }}
            >
              Customize layout…
            </button>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <TiptapEditorProvider value={editor}>
      <div
        className={`document-editor-panel ${isFullscreen ? 'fullscreen' : ''} ${
          presentation === 'reading' ? 'reading' : ''
        }`}
      >
        <RichTextTabBar trailing={overflowMenu} />
        <DocumentEditorToolbar />
        <div className="document-editor-panel-content">
          {collabMode && collabYdoc && activePageId ? (
            <CollaborativeProseEditor
              key={`${currentDocId}:${activePageId}:${collabSessionEpoch}`}
              ydoc={collabYdoc}
              field={`prose:${activePageId}`}
              pageId={activePageId}
              seedHtml={
                useRichTextPagesStore.getState().pages[activePageId]?.content ?? '<p></p>'
              }
              onEditorReady={handleEditorReady}
            />
          ) : (
            <TiptapEditor onEditorReady={handleEditorReady} />
          )}
        </div>
      </div>
    </TiptapEditorProvider>
  );
}
