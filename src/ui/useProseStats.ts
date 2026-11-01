/**
 * Publish live counts for the open prose page (DSK-211), for the status line and
 * Document stats. Mounted with the prose editor, like `useDocumentNaming`.
 *
 * The whole page is recounted after a pause in typing; the selection's count
 * follows the selection at once. Transactions rather than `update` events, so a
 * page loaded without emitting an update is still counted.
 */
import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import { countProse, countWordsBetween, useProseStatsStore } from '../services/proseStats';

/** Pause in typing before the whole page is recounted. */
export const RECOUNT_AFTER_MS = 250;

export function useProseStats(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    const { setStats } = useProseStatsStore.getState();
    let page = countProse(editor.state.doc);
    let recount: ReturnType<typeof setTimeout> | null = null;

    const publish = () => {
      const { from, to } = editor.state.selection;
      setStats({ ...page, selectionWords: countWordsBetween(editor.state.doc, from, to) });
    };

    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) {
        if (transaction.selectionSet) publish();
        return;
      }
      if (recount) clearTimeout(recount);
      recount = setTimeout(() => {
        recount = null;
        page = countProse(editor.state.doc);
        publish();
      }, RECOUNT_AFTER_MS);
    };

    publish();
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      if (recount) clearTimeout(recount);
      setStats(null);
    };
  }, [editor]);
}
