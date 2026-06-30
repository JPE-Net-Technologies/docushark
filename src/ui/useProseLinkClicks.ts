/**
 * useProseLinkClicks — DOM-level click handling for inline links in a Tiptap
 * prose surface.
 *
 * A DOM `click` listener (rather than ProseMirror's `handleClickOn`) is used
 * because `handleClickOn` doesn't fire consistently for inline marks across
 * browsers. It:
 *   - opens `http(s)` / `mailto` links in a new tab, and
 *   - with `headingAnchors`, resolves `docushark://heading/<pageId>/<index>`
 *     in-document anchors as cross-page heading navigation (switch the active
 *     prose page, then scroll the heading into view).
 *
 * Shared by every prose surface so heading links behave identically: the local
 * `TiptapEditor` and relay `CollaborativeProseEditor` (both via
 * `useProseEditorChrome`) and the read-only `ProsePreview`. (Heading nav used to
 * be wired only into the local editor — JP-417: heading links were noops in
 * collab docs and the preview.)
 */

import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';

export interface ProseLinkClickOptions {
  /**
   * Resolve in-document `docushark://heading/<pageId>/<index>` anchors as
   * cross-page heading navigation. Both prose page lists and the active page are
   * driven by `richTextPagesStore`, so this works for local and collab docs
   * alike.
   */
  headingAnchors?: boolean;
}

export function useProseLinkClicks(
  editor: Editor | null,
  opts: ProseLinkClickOptions = {},
): void {
  const { headingAnchors = false } = opts;

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
}
