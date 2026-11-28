/**
 * Each writing page's first heading, for its label (DSK-260).
 *
 * In a shared document a page's text lives in its `prose:<id>` fragment and a
 * collaborator may retitle any page, so the headings are read from there,
 * again shortly after the shared document changes. Otherwise they come from
 * the page store's HTML, which the editor keeps current.
 */

import { useEffect, useMemo, useState } from 'react';
import { useCollaborationStore } from '../../collaboration/collaborationStore';
import { useRichTextPagesStore } from '../../store/richTextPagesStore';
import { firstHeadingInHtml } from './pageLabel';

/** How long the shared document must be still before headings are read again. */
export const HEADING_REFRESH_MS = 400;

export function useProsePageHeadings(): Readonly<Record<string, string | null>> {
  const pages = useRichTextPagesStore((s) => s.pages);
  const shared = useCollaborationStore((s) => s.isActive);
  const sessionEpoch = useCollaborationStore((s) => s.sessionEpoch);
  const [sharedChange, setSharedChange] = useState(0);

  useEffect(() => {
    if (!shared) return undefined;
    const doc = useCollaborationStore.getState().getYjsDocument()?.getDoc();
    if (!doc) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setSharedChange((n) => n + 1), HEADING_REFRESH_MS);
    };
    doc.on('update', onUpdate);
    return () => {
      clearTimeout(timer);
      doc.off('update', onUpdate);
    };
  }, [shared, sessionEpoch]);

  return useMemo(() => {
    const doc = shared ? useCollaborationStore.getState().getYjsDocument() : null;
    const headings: Record<string, string | null> = {};
    for (const [id, page] of Object.entries(pages)) {
      headings[id] = doc ? doc.getProsePageHeading(id) : firstHeadingInHtml(page.content);
    }
    return headings;
    // `sharedChange` and `sessionEpoch` are the triggers for re-reading the shared document.
  }, [pages, shared, sharedChange, sessionEpoch]);
}
