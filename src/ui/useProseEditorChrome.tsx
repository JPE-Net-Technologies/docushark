/**
 * useProseEditorChrome — the shared chrome both prose editors hang off a Tiptap
 * instance.
 *
 * The local-only `TiptapEditor` and the relay `CollaborativeProseEditor` differ
 * only in their essential axes (extensions: history vs Collaboration; content
 * source: `richTextStore` vs the Y.XmlFragment; the `onUpdate` target). Every
 * other per-instance behavior — the right-click formatting menu, the spellcheck
 * popover, the custom-dictionary loader, inline-link handling, and `blob://`
 * image resolution — is identical, and used to be copied into both. That
 * duplication is the "two editors drift apart" seam that caused the collab-prose
 * data-loss bugs, so it lives here once and both editors call it.
 *
 * Returns the `onContextMenu` handler to spread on the editor container plus the
 * `overlay` node (the menu + popover portals) to render inside it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { useRichTextStore } from '../store/richTextStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { rebuildSpellcheck } from '../tiptap/SpellcheckExtension';
import { SpellcheckService } from '../services/SpellcheckService';
import { SpellcheckPopover } from './SpellcheckPopover';
import { DocumentEditorContextMenu } from './DocumentEditorContextMenu';
import { useResolveBlobImages } from './useProseBlobImages';

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
}

interface SpellPopoverState {
  word: string;
  range: { from: number; to: number };
  x: number;
  y: number;
}

export interface ProseEditorChromeOptions {
  /**
   * Handle in-document `docushark://heading/<pageId>/<index>` anchors as
   * cross-page heading navigation. This is a local-doc concern (the legacy
   * editor owns multi-page nav); the collab editor leaves it off so its
   * behavior is unchanged.
   */
  headingAnchors?: boolean;
}

export interface ProseEditorChrome {
  /** Spread onto the editor container `div`. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** Render inside the editor container (context menu + spellcheck popover). */
  overlay: React.ReactNode;
}

export function useProseEditorChrome(
  editor: Editor | null,
  opts: ProseEditorChromeOptions = {},
): ProseEditorChrome {
  const { headingAnchors = false } = opts;
  const customDictionary = useRichTextStore((s) => s.content.customDictionary);
  const spellcheckMode = useUIPreferencesStore((s) => s.appearancePrefs.spellcheck);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
  });
  const [spellPopover, setSpellPopover] = useState<SpellPopoverState | null>(null);

  // Right-click: show the spellcheck popover when over a misspelled word,
  // otherwise the formatting context menu.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!editor) return;
      const target = e.target as HTMLElement | null;
      const errorSpan = target?.closest('.spellcheck-error') as HTMLElement | null;
      if (errorSpan) {
        e.preventDefault();
        const word = errorSpan.textContent || '';
        const pos = editor.view.posAtDOM(errorSpan, 0);
        const range = { from: pos, to: pos + word.length };
        setSpellPopover({ word, range, x: e.clientX, y: e.clientY });
        return;
      }
      e.preventDefault();
      setContextMenu({ isOpen: true, x: e.clientX, y: e.clientY });
    },
    [editor],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Push the document's custom dictionary into the spellcheck service whenever
  // it changes, then force a fresh pass so already-typed words update.
  useEffect(() => {
    if (!editor) return;
    if (customDictionary && customDictionary.length > 0) {
      SpellcheckService.loadCustomWords(customDictionary);
      // rebuildSpellcheck dispatches a Tiptap transaction; defer past the
      // effect commit so flushSync doesn't fire inside a lifecycle.
      queueMicrotask(() => {
        if (!editor.isDestroyed) rebuildSpellcheck(editor.view);
      });
    }
  }, [editor, customDictionary]);

  // Spellcheck mode (custom / system / off). Toggle the contenteditable's NATIVE
  // browser spellcheck — only `system` wants it on; `custom`/`off` turn it off so
  // the native red squiggle doesn't stack on the built-in checker's underline (the
  // double-underline bug). `spellcheck` isn't a ProseMirror-managed attribute, so
  // an imperative setAttribute sticks. Then rebuild the custom decorations so they
  // clear when leaving `custom` and re-appear when returning to it.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute('spellcheck', spellcheckMode === 'system' ? 'true' : 'false');
    rebuildSpellcheck(editor.view);
  }, [editor, spellcheckMode]);

  // DOM-level click handler so inline link clicks reliably fire (handleClickOn
  // doesn't trigger consistently for inline marks in all browsers). Opens
  // http(s)/mailto in a new tab; with `headingAnchors`, also resolves
  // `docushark://heading` cross-page nav.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !dom.contains(anchor)) return;
      const href = anchor.getAttribute('href') || '';

      if (headingAnchors) {
        const headingMatch = href.match(/^docushark:\/\/heading\/([^/]+)\/(\d+)$/);
        if (headingMatch) {
          event.preventDefault();
          event.stopPropagation();
          const pageId = headingMatch[1]!;
          const headingIndex = parseInt(headingMatch[2]!, 10);
          import('../store/richTextPagesStore').then(({ useRichTextPagesStore }) => {
            const store = useRichTextPagesStore.getState();
            if (store.activePageId !== pageId) store.setActivePage(pageId);
            const scrollToHeading = (attempts = 0) => {
              const headings = document.querySelectorAll(
                '.tiptap-prose h1, .tiptap-prose h2, .tiptap-prose h3, .tiptap-prose h4, .tiptap-prose h5, .tiptap-prose h6',
              );
              const el = headings[headingIndex] as HTMLElement | undefined;
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              } else if (attempts < 30) {
                requestAnimationFrame(() => scrollToHeading(attempts + 1));
              }
            };
            requestAnimationFrame(() => scrollToHeading());
          });
          return;
        }
      }

      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor, headingAnchors]);

  // Right-click must not collapse a multi-cell selection (JP-416 item 3). The
  // right-button `mousedown` reaches ProseMirror's table handler, which moves the
  // selection to the clicked cell *before* `onContextMenu` fires — so the menu's
  // Merge/background/move actions would act on one cell instead of the selected
  // block. When the current selection is a CellSelection, swallow the right-button
  // mousedown so PM leaves it intact; the contextmenu event still fires.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 2) return;
      if (editor.state.selection instanceof CellSelection) {
        event.preventDefault();
      }
    };
    dom.addEventListener('mousedown', onMouseDown);
    return () => dom.removeEventListener('mousedown', onMouseDown);
  }, [editor]);

  // Resolve blob:// images to object URLs (initial + on every update) —
  // collaborators on other devices embed images we must load. Shared with the
  // read-only `ProsePreview` surface so they can't drift (see the hook).
  useResolveBlobImages(editor);

  const overlay = (
    <>
      {contextMenu.isOpen && editor && (
        <DocumentEditorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          editor={editor}
        />
      )}
      {spellPopover && editor && (
        <SpellcheckPopover
          editor={editor}
          word={spellPopover.word}
          range={spellPopover.range}
          x={spellPopover.x}
          y={spellPopover.y}
          onClose={() => setSpellPopover(null)}
        />
      )}
    </>
  );

  return { onContextMenu, overlay };
}
