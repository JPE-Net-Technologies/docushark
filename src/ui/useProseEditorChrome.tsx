/**
 * useProseEditorChrome — the shared chrome both prose editors hang off a Tiptap
 * instance.
 *
 * The local-only `TiptapEditor` and the relay `CollaborativeProseEditor` differ
 * only in their essential axes (extensions: history vs Collaboration; content
 * source: `richTextStore` vs the Y.XmlFragment; the `onUpdate` target). Every
 * other per-instance behavior — the right-click menu (with a misspelled word's
 * fixes and a link's actions), the custom-dictionary loader, inline-link
 * handling, and `blob://`
 * image resolution — is identical, and used to be copied into both. That
 * duplication is the "two editors drift apart" seam that caused the collab-prose
 * data-loss bugs, so it lives here once and both editors call it.
 *
 * Returns the `onContextMenu` handler to spread on the editor container plus the
 * `overlay` node (the menu and link dialog portals) to render inside it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { useRichTextStore } from '../store/richTextStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { rebuildSpellcheck } from '../tiptap/SpellcheckExtension';
import { SpellcheckService } from '../services/SpellcheckService';
import { DocumentEditorContextMenu } from './DocumentEditorContextMenu';
import { InsertLinkDialog } from './InsertLinkDialog';
import { useResolveBlobImages } from './useProseBlobImages';
import { followProseLink, useProseLinkClicks } from './useProseLinkClicks';
import { readMobileActive } from './layout/useMobileAdaptation';

/** Select the image whose node view holds `dom` (a long-press on a phone). */
function selectImageNode(editor: Editor, dom: Element): void {
  const pos = editor.view.posAtDOM(dom, 0);
  if (editor.state.doc.nodeAt(pos)?.type.name === 'image') editor.commands.setNodeSelection(pos);
}

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  /** The misspelled word that was right-clicked, if any (DSK-213). */
  misspelling?: { word: string; range: { from: number; to: number } };
  /** The link that was right-clicked, if any: its href and a position inside it. */
  link?: { href: string; pos: number };
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
  /** Render inside the editor container (context menu + link dialog). */
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
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  // Live editability, mirrored into state so the effects below re-run when a
  // permission flip lands mid-session (JP-370 `setEditable` — which emits
  // `update` — never remounts the editor, so a plain `editor.isEditable` read
  // in an effect would be one flip stale).
  const [editable, setEditableState] = useState(() => editor?.isEditable ?? false);
  useEffect(() => {
    if (!editor) return;
    const sync = () => setEditableState(editor.isEditable);
    sync();
    editor.on('update', sync);
    editor.on('create', sync);
    return () => {
      editor.off('update', sync);
      editor.off('create', sync);
    };
  }, [editor]);

  // Right-click opens the context menu. Over a misspelled word its fixes head
  // the menu, and over a link its actions do (DSK-213; the word's fixes used
  // to open a separate popover). Read-only surfaces get no menu — it leads to
  // programmatic writes (`insertContent`, formatting chains) that
  // `editable: false` does not block, so the whole handler returns early. No
  // `preventDefault`: the native menu still offers copy.
  //
  // On a phone (DSK-202) a long-press fires this event too, and a long-press is
  // the system's selection gesture: a menu at the finger covered the selection
  // handles and, with the keyboard up, ran under the bar. The phone's bar
  // offers the spelling fixes and image actions instead, so the phone layout
  // opens no menu. On text the system keeps its handles and its own
  // copy-and-paste bar; on an image, the browser's image menu gives way to
  // selecting the image, which brings its actions into the bar.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!editor || !editor.isEditable) return;
      const target = e.target as HTMLElement | null;
      if (readMobileActive()) {
        const image = target?.closest('.resizable-image-container');
        if (image && editor.view.dom.contains(image)) {
          e.preventDefault();
          selectImageNode(editor, image);
        }
        return;
      }
      e.preventDefault();
      const menu: ContextMenuState = { isOpen: true, x: e.clientX, y: e.clientY };
      // Read from what was right-clicked, not the selection: the caret move a
      // right-click makes reaches the editor only after this handler runs.
      const errorSpan = target?.closest('.spellcheck-error') as HTMLElement | null;
      if (errorSpan) {
        const word = errorSpan.textContent || '';
        const from = editor.view.posAtDOM(errorSpan, 0);
        menu.misspelling = { word, range: { from, to: from + word.length } };
      }
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (anchor && editor.view.dom.contains(anchor)) {
        menu.link = { href: anchor.getAttribute('href') ?? '', pos: editor.view.posAtDOM(anchor, 0) };
      }
      setContextMenu(menu);
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

  // Spellcheck mode (custom / system / off) × editability. Toggle the
  // contenteditable's NATIVE browser spellcheck — only `system` on an EDITABLE
  // surface wants it on; `custom`/`off` turn it off so the native red squiggle
  // doesn't stack on the built-in checker's underline (the double-underline
  // bug), and a read-only surface always turns it off (readers aren't
  // composing text; squiggles there are noise). `spellcheck` isn't a
  // ProseMirror-managed attribute, so an imperative setAttribute sticks. Then
  // rebuild the custom decorations so they clear when leaving `custom`/losing
  // editability and re-appear when returning. The editable+custom arm preps
  // the dictionary first (idempotent) — an editor born read-only skipped
  // `onCreate`'s prepare, so a mid-session promotion (JP-370) lands here
  // needing both the load and the first pass.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dom.setAttribute(
      'spellcheck',
      editable && spellcheckMode === 'system' ? 'true' : 'false',
    );
    if (editable && spellcheckMode === 'custom') {
      void SpellcheckService.prepare().then(() => {
        if (!editor.isDestroyed) rebuildSpellcheck(editor.view);
      });
    } else {
      rebuildSpellcheck(editor.view);
    }
  }, [editor, spellcheckMode, editable]);

  // Inline link click handling (open http(s)/mailto; resolve heading anchors
  // when `headingAnchors`). Shared with `ProsePreview` so every prose surface
  // behaves identically — see the hook.
  useProseLinkClicks(editor, { headingAnchors });

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
          misspelling={contextMenu.misspelling}
          link={contextMenu.link}
          onEditLink={() => setLinkDialogOpen(true)}
          onOpenLink={(href) => followProseLink(href, { headingAnchors })}
        />
      )}
      {linkDialogOpen && editor && (
        <InsertLinkDialog editor={editor} onClose={() => setLinkDialogOpen(false)} />
      )}
    </>
  );

  return { onContextMenu, overlay };
}
