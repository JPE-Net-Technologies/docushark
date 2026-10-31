/**
 * Name the open document from its content (DSK-209). Mounted with the prose
 * editor; acts only while the document still has the default name.
 *
 * - **A leading heading names it.** Once the writer has moved past a heading
 *   in the first block (or it arrived by paste), that heading becomes the
 *   document's name, with an Undo. Not while they're still typing it, and not
 *   when an old untitled document is merely opened.
 * - **Otherwise, one prompt.** After a few words and a pause, a toast offers
 *   to rename, opening the title with the suggestion selected. Once per
 *   document.
 *
 * Only the writer's own edits count: a collaborator's changes and document
 * loads don't start either rule. A rename by hand ends both, since they only
 * act on the default name; an Undo is remembered so the heading rule doesn't
 * apply again.
 */
import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from 'y-prosemirror';
import { usePersistenceStore, UNTITLED_DOCUMENT_NAME } from '../store/persistenceStore';
import { useNotificationStore } from '../store/notificationStore';
import {
  leadingHeadingName,
  namingMemory,
  suggestDocumentName,
  useDocumentNamingStore,
  wordCount,
} from '../services/documentNaming';

/** How long the writer pauses before the one prompt. */
export const PROMPT_AFTER_PAUSE_MS = 4000;

/** Words of content before a document is worth prompting about. */
const PROMPT_MIN_WORDS = 3;

const isUntitled = () => usePersistenceStore.getState().currentDocumentName === UNTITLED_DOCUMENT_NAME;
const currentDocId = () => usePersistenceStore.getState().currentDocumentId;

export function useDocumentNaming(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    let pause: ReturnType<typeof setTimeout> | null = null;
    // Whether the writer has edited this document here, and touched its first block.
    let typed = false;
    let touchedLeading = false;

    const clearPause = () => {
      if (pause) clearTimeout(pause);
      pause = null;
    };

    // A different document: start over. (A new document gaining its first id is the same one.)
    const unsubscribe = usePersistenceStore.subscribe((state, previous) => {
      if (state.currentDocumentId !== previous.currentDocumentId && previous.currentDocumentId !== null) {
        typed = false;
        touchedLeading = false;
        clearPause();
      }
    });

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const untitled = isUntitled();
      useDocumentNamingStore.getState().setSuggestion(untitled ? suggestDocumentName(editor.state.doc) : null);
      if (!untitled || !editor.isEditable) {
        clearPause();
        return;
      }

      const own = isOwnEdit(transaction);
      if (own && transaction.docChanged) {
        typed = true;
        const before = transaction.before.firstChild;
        const after = transaction.doc.firstChild;
        if (!before || !after || !before.eq(after)) touchedLeading = true;
      }

      const docId = currentDocId();
      if (docId && namingMemory.wasDeclined(docId)) return;

      const heading = leadingHeadingName(editor.state.doc);
      if (heading) {
        clearPause();
        const pasted = transaction.getMeta('uiEvent') === 'paste';
        const movedPast = editor.state.selection.from > (editor.state.doc.firstChild?.nodeSize ?? 0);
        if (own && (pasted || (touchedLeading && movedPast))) nameFromHeading(heading);
        return;
      }

      if (!own || !transaction.docChanged) return;
      clearPause();
      if (!typed || wordCount(editor.state.doc) < PROMPT_MIN_WORDS || (docId && namingMemory.wasPrompted(docId))) return;
      pause = setTimeout(() => {
        pause = null;
        promptForName(editor);
      }, PROMPT_AFTER_PAUSE_MS);
    };

    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      unsubscribe();
      clearPause();
      useDocumentNamingStore.getState().setSuggestion(null);
    };
  }, [editor]);
}

/**
 * The writer's own change: not a load (`setContent` marks `preventUpdate`) and
 * not a collaborator's change arriving through y-prosemirror.
 */
function isOwnEdit(transaction: Transaction): boolean {
  if (transaction.getMeta('preventUpdate')) return false;
  const sync = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return !sync?.isChangeOrigin;
}

function nameFromHeading(name: string): void {
  usePersistenceStore.getState().renameDocument(name);
  // The id after the rename: naming a new local document saves it, giving it one.
  const docId = currentDocId();
  useNotificationStore.getState().success(`Named “${name}” from its heading.`, {
    // Long enough to notice an automatic rename and take it back.
    duration: 10000,
    actionLabel: 'Undo',
    onAction: () => {
      if (docId) namingMemory.markDeclined(docId);
      // Only that document, and only the name it was given: another document
      // opened since, or a name typed since, is left alone.
      const now = usePersistenceStore.getState();
      if (now.currentDocumentId === docId && now.currentDocumentName === name) now.renameDocument(UNTITLED_DOCUMENT_NAME);
    },
  });
}

function promptForName(editor: Editor): void {
  const docId = currentDocId();
  if (editor.isDestroyed || !editor.isEditable || !isUntitled() || !docId) return;
  if (namingMemory.wasPrompted(docId) || namingMemory.wasDeclined(docId)) return;
  namingMemory.markPrompted(docId);
  useNotificationStore.getState().info('Give this document a name?', {
    actionLabel: 'Rename',
    // The title of this document, not one opened since.
    onAction: () => {
      if (currentDocId() === docId) useDocumentNamingStore.getState().requestTitleEdit();
    },
    duration: 10000,
  });
}
